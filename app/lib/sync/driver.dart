import 'dart:async';

import 'dart:convert';

import 'package:drift/drift.dart';

import '../api/sync_api.dart';
import '../store/database.dart' hide BaseEntry;
import 'engine.dart';

/// Local projection of the sync state: what the engine needs to see as the
/// "local tree", derived from the SQLite mirror.
///
/// In the app the local tree IS the mirror: the root buckets are synthetic
/// (the app has no browser bookmark bar), so the adapter supplies:
///   - a synthetic bar root (id 'root', parentId '', folder)
///   - the canonical holder row (id othersId) marked isOtherRoot
///   - every mirror row as a child, its index = rank among siblings by
///     position (the mirror stores server positions; the sweep compares
///     ranks, which is exactly what position ordering yields)
class LocalTreeSource {
  LocalTreeSource(this._db);
  final AppDatabase _db;

  static const barRootId = 'root';

  Future<List<LocalNode>> load(String othersId) async {
    final rows = await _db.allNodes();

    // group children by parent, sorted by position then created (server order)
    final byParent = <String, List<Node>>{};
    for (final r in rows) {
      (byParent[r.parentId] ??= []).add(r);
    }
    for (final arr in byParent.values) {
      arr.sort((a, b) {
        final c = a.position.compareTo(b.position);
        if (c != 0) return c;
        return a.createdAt.compareTo(b.createdAt);
      });
    }

    final out = <LocalNode>[
      // synthetic bar root: server top-level rows (parentId '') live here
      LocalNode(
        id: barRootId,
        parentId: '',
        type: 'folder',
        title: '书签栏',
        index: 0,
      ),
    ];

    // the canonical holder is structurally bound: emit it as the other root
    final hasHolder = rows.any((r) => r.id == othersId);
    if (hasHolder) {
      out.add(LocalNode(
        id: othersId,
        parentId: '',
        type: 'folder',
        title: '其他书签',
        index: 0,
        isOtherRoot: true,
      ));
    }

    for (final r in rows) {
      if (r.id == othersId) continue; // the root bucket itself
      final siblings = byParent[r.parentId == '' ? '' : r.parentId] ?? const <Node>[];
      final index = siblings.indexWhere((s) => s.id == r.id);
      out.add(LocalNode(
        id: r.id,
        parentId: r.parentId.isEmpty ? barRootId : r.parentId,
        type: r.type,
        title: r.title,
        url: r.url,
        index: index < 0 ? 0 : index,
        dateAdded: r.createdAt, // pass-3 creates carry the row clock
      ));
    }
    return out;
  }
}

/// The reconcile driver: fetch server tree → plan → push server ops →
/// execute local ops → advance base (only on success). Single-flight so
/// WS bursts cannot interleave. Mirrors extension/src/background.ts
/// reconcileOnce semantics.
class SyncDriver {
  SyncDriver({
    required this.api,
    required this.db,
    required this.deviceId,
    required this.othersId,
  }) : _local = LocalTreeSource(db);

  final SyncApi api;
  final AppDatabase db;
  final String deviceId;
  String othersId;
  final LocalTreeSource _local;

  bool _running = false;
  bool _again = false;
  Timer? _debounce;
  Timer? _poll;
  StreamSubscription<int>? _ws;

  /// Status surface for the UI chip.
  SyncStatus status = SyncStatus.unconfigured;
  String? lastError;
  DateTime? lastSuccessAt;
  SyncStats? lastStats;

  final _statusController = StreamController<SyncStatus>.broadcast();
  Stream<SyncStatus> get statusStream => _statusController.stream;

  /// Invoked after every successful reconcile cycle — observers hook
  /// "server data may have changed" side-effects here (e.g. the trash
  /// view refetches, since the mirror only holds live rows).
  void Function()? onSynced;

  void _setStatus(SyncStatus s, {String? error}) {
    status = s;
    lastError = error;
    _statusController.add(s);
  }

  /// Start WS listening + the 1-minute fallback poll (extension md-poll).
  void start() {
    _connectWs();
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(minutes: 1), (_) {
      unawaited(reconcile('poll'));
    });
  }

  void stop() {
    _ws?.cancel();
    _ws = null;
    _poll?.cancel();
    _poll = null;
    _debounce?.cancel();
    _debounce = null;
  }

  void _connectWs() {
    _ws?.cancel();
    try {
      _ws = api.revisions().listen(
        (_) => _schedule('ws-rev'),
        onError: (_) {
          _setStatus(SyncStatus.disconnected);
          _reconnectLater();
        },
        onDone: () {
          if (status != SyncStatus.unconfigured) {
            _setStatus(SyncStatus.disconnected);
            _reconnectLater();
          }
        },
      );
    } catch (e) {
      _setStatus(SyncStatus.disconnected, error: '$e');
      _reconnectLater();
    }
  }

  void _reconnectLater([int attempt = 0]) {
    final delay = backoffDelayMs(attempt);
    Timer(Duration(milliseconds: delay), () {
      if (status != SyncStatus.unconfigured) _connectWs();
    });
  }

  /// Debounced reconcile (WS rev bursts collapse into one run).
  void _schedule(String reason) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 500), () {
      unawaited(reconcile(reason));
    });
  }

  /// Journal a local edit so the next reconcile pushes it with the right
  /// LWW timestamp. Not an op queue — the engine re-derives the diff.
  Future<void> journalTouch(
    String id, {
    bool removed = false,
    String? title,
    String? url,
    List<String>? tags,
    bool reordered = false,
  }) async {
    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    await db.into(db.touches).insertOnConflictUpdate(TouchesCompanion.insert(
      id: id,
      at: Value(now),
      removed: Value(removed),
      title: Value(title),
      url: Value(url),
      tags: Value(tags == null ? null : jsonEncode(tags)),
      reordered: Value(reordered),
    ));
    _schedule('local-edit');
  }

  /// Journal a reorder of a parent's children (mirror-level sort).
  Future<void> journalReorder(String parentId) async {
    await journalTouch(parentId, reordered: true, title: null);
  }

  /// The reconcile cycle. Re-entrant calls coalesce (single-flight + rerun).
  Future<void> reconcile(String reason) async {
    if (status == SyncStatus.unconfigured) {
      // first run: no status yet — the pairing flow sets the token before
      // the first reconcile; a 401 during it flips unauthorized
      _setStatus(SyncStatus.online);
    } else if (!status.canSync) {
      return;
    }
    if (_running) {
      _again = true;
      return;
    }
    _running = true;
    try {
      await _once(reason);
      if (_again) {
        _again = false;
        await _once('coalesced');
      }
      onSynced?.call();
    } catch (e) {
      // a failed reconcile never advances base: offline edits replay
      final msg = e.toString();
      if (msg.contains('401') || msg.contains('revoked')) {
        _setStatus(SyncStatus.unauthorized, error: msg);
      } else {
        _setStatus(SyncStatus.disconnected, error: msg);
      }
    } finally {
      _running = false;
    }
  }

  Future<void> _once(String reason) async {
    final tree = await api.tree();
    othersId = tree.othersId;

    final base = await _loadBase();
    final touch = await _loadTouch();
    final local = await _local.load(othersId);

    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final plan = planSync(PlanInput(
      server: [for (final b in tree.nodes) _toServerNode(b)],
      local: local,
      base: base,
      touch: touch,
      deviceId: deviceId,
      now: now,
      othersId: othersId,
    ));
    lastStats = plan.stats;

    // 1. push server ops first — the server's LWW judges each one
    if (plan.serverOps.isNotEmpty) {
      await api.apply([for (final o in plan.serverOps) o.toJson(deviceId)]);
    }

    // 2. execute local ops against the SQLite mirror
    await _executeLocalOps(plan.chromeOps);

    // 3. both sides succeeded → advance base and clear consumed touches
    await _advanceBase(plan, tree.head);
    await db.delete(db.touches).go();

    _setStatus(SyncStatus.online);
    lastSuccessAt = DateTime.now();
    if (plan.stats.planned > 0) {
      _debounce?.cancel();
    }
  }

  ServerNode _toServerNode(ServerBookmark b) => ServerNode(
        id: b.id,
        parentId: b.parentId,
        type: b.type,
        title: b.title,
        url: b.url,
        position: b.position,
        revision: b.revision,
        updatedAt: b.updatedAt,
        deviceId: b.deviceId,
      );

  Future<Base?> _loadBase() async {
    final head = await db.metaInt('head');
    if (head == 0) return null;
    final others = await db.metaValue('others_id') ?? othersId;
    final rows = await db.select(db.baseEntries).get();
    final entries = <String, BaseEntry>{};
    for (final r in rows) {
      final j = jsonDecode(r.serverJson) as Map<String, dynamic>;
      entries[r.serverId] = BaseEntry(
        server: ServerNode.fromJson(j),
        // the stored localId is the mirror row this server row is bound to
        // (== serverId for rows absorbed from the server; App-created rows
        // keep their own timestamp-hash id)
        localId: r.localId ?? r.serverId,
        appliedAt: r.appliedAt,
      );
    }
    return Base(head: head, othersId: others, entries: entries);
  }

  Future<TouchJournal> _loadTouch() async {
    final rows = await db.select(db.touches).get();
    final out = <String, TouchEntry>{};
    for (final r in rows) {
      out[r.id] = TouchEntry(
        at: r.at,
        removed: r.removed,
        title: r.title,
        url: r.url,
        tags: r.tags == null ? null : (jsonDecode(r.tags!) as List).cast<String>(),
        reordered: r.reordered,
      );
    }
    return out;
  }

  Future<void> _executeLocalOps(List<LocalOp> ops) async {
    // creates are topologically ordered by the engine (parents first)
    for (final op in ops) {
      // locate the mirror row via the op's LOCAL id when the engine provides
      // one (App-created rows keep their own id, which differs from the
      // minted server id); rows absorbed from the server have
      // localId == serverId.
      switch (op) {
        case LocalCreate(:final serverId, :final parentServerId, :final type, :final title, :final url, :final index):
          final pos = await _positionFor(parentServerId, index);
          await db.into(db.nodes).insertOnConflictUpdate(NodesCompanion.insert(
                id: serverId,
                parentId: Value(parentServerId),
                type: type,
                title: title,
                url: Value(url),
                position: Value(pos),
                createdAt: Value(DateTime.now().millisecondsSinceEpoch ~/ 1000),
              ));
        case LocalUpdate(:final serverId, :final localId, :final title, :final url):
          final rowId = localId ?? serverId;
          await (db.update(db.nodes)..where((n) => n.id.equals(rowId))).write(
            NodesCompanion(
              title: Value(title),
              url: url == null ? const Value.absent() : Value(url),
            ),
          );
        case LocalMove(:final serverId, :final localId, :final parentServerId, :final index):
          final rowId = localId ?? serverId;
          final pos = await _positionFor(parentServerId, index);
          await (db.update(db.nodes)..where((n) => n.id.equals(rowId))).write(
            NodesCompanion(parentId: Value(parentServerId), position: Value(pos)),
          );
        case LocalRemove(:final serverId, :final localId):
          // the server tree is the truth: a mirror row the server dropped is
          // gone here too (the server holds it in its own trash)
          final rowId = localId ?? serverId;
          await (db.delete(db.nodes)..where((n) => n.id.equals(rowId))).go();
      }
    }
  }

  /// Recompute a position for the slot [index] under [parentId].
  Future<double> _positionFor(String parentId, int index) async {
    final sibs = await (db.select(db.nodes)..where((n) => n.parentId.equals(parentId))).get();
    sibs.sort((a, b) => a.position.compareTo(b.position));
    if (sibs.isEmpty) return 1.0;
    if (index <= 0) return sibs.first.position - 1.0;
    if (index >= sibs.length) return sibs.last.position + 1.0;
    return (sibs[index - 1].position + sibs[index].position) / 2.0;
  }

  Future<void> _advanceBase(SyncPlan plan, int head) async {
    await db.transaction(() async {
      await db.delete(db.baseEntries).go();
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      for (final e in plan.newBaseEntries.entries) {
        await db.into(db.baseEntries).insert(BaseEntriesCompanion.insert(
              serverId: e.key,
              serverJson: jsonEncode(e.value.server.toJson()),
              localId: Value(e.value.localId),
              appliedAt: Value(now),
            ));
      }
      await db.setMetaInt('head', head);
      await db.setMetaValue('others_id', othersId);
    });
  }
}

enum SyncStatus {
  unconfigured, // no pair yet
  online,
  disconnected, // network/WS down — offline edits queue in the touch journal
  unauthorized; // device token revoked

  bool get canSync => this == online || this == disconnected;

  String get label => switch (this) {
        SyncStatus.unconfigured => '未配置',
        SyncStatus.online => '已同步',
        SyncStatus.disconnected => '离线',
        SyncStatus.unauthorized => '令牌已失效',
      };
}
