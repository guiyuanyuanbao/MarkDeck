// Pure-Dart three-way reconciliation engine for the MarkDeck Android app.
// No IO, no Flutter imports — unit-tested with `flutter test`. The driver in
// driver.dart supplies server/local trees and executes the planned ops.
//
// This is a faithful port of extension/src/reconcile.ts (the TS engine);
// algorithm invariants are locked by the ported Vitest suites and the
// differential fixtures under test/fixtures/engine_cases/.
//
// Model:
//   base  — snapshot of the server tree at the last successful reconcile.
//           In the app, localId == serverId always (we own the local tree),
//           but the field is kept so the algorithm matches the TS engine.
//   server — the server's live tree right now (GET /api/sync/tree).
//   local — the app's live tree right now (SQLite nodes table).
//   touch — tiny journal of local edits since the last reconcile:
//           { localId → { at, removed?, title?, url?, tags?, reordered? } }.
//           Supplies LWW timestamps; NOT an op queue — edits are re-derived
//           by diffing local against base.
//
// The plan is idempotent: reconciling the same three trees twice yields
// zero ops the second time. A failed reconcile never advances base, so
// offline edits replay automatically without a queue or echo guard.

// ---- wire node (server Bookmark row, sync-scoped fields) ----

class ServerNode {
  ServerNode({
    required this.id,
    required this.parentId,
    required this.type,
    required this.title,
    this.url,
    required this.position,
    required this.revision,
    required this.updatedAt,
    this.deviceId,
  });

  factory ServerNode.fromJson(Map<String, dynamic> j) => ServerNode(
        id: j['id'] as String,
        parentId: (j['parentId'] as String?) ?? '',
        type: j['type'] as String,
        title: (j['title'] as String?) ?? '',
        url: j['url'] as String?,
        position: ((j['position'] as num?) ?? 0).toDouble(),
        revision: ((j['revision'] as num?) ?? 0).toInt(),
        updatedAt: ((j['updatedAt'] as num?) ?? 0).toInt(),
        deviceId: j['deviceId'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'parentId': parentId,
        'type': type,
        'title': title,
        if (url != null) 'url': url,
        'position': position,
        'revision': revision,
        'updatedAt': updatedAt,
        if (deviceId != null) 'deviceId': deviceId,
      };

  final String id;
  final String parentId;
  final String type; // 'folder' | 'url'
  final String title;
  final String? url;
  final double position;
  final int revision;
  final int updatedAt;
  final String? deviceId;

  ServerNode copyWith({String? parentId, String? title, int? updatedAt}) => ServerNode(
        id: id,
        parentId: parentId ?? this.parentId,
        type: type,
        title: title ?? this.title,
        url: url,
        position: position,
        revision: revision,
        updatedAt: updatedAt ?? this.updatedAt,
        deviceId: deviceId,
      );

  @override
  bool operator ==(Object other) => other is ServerNode && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

class LocalNode {
  LocalNode({
    required this.id,
    required this.parentId,
    required this.type,
    required this.title,
    this.url,
    required this.index,
    this.dateAdded,
    this.isOtherRoot = false,
  });

  final String id;
  final String parentId; // '' for the two root buckets themselves
  final String type; // 'folder' | 'url'
  final String title;
  final String? url;
  final int index;
  final int? dateAdded; // unix seconds
  final bool isOtherRoot; // adapter marks the browser's other-bookmarks root
}

class BaseEntry {
  BaseEntry({required this.server, required this.localId, this.appliedAt = 0});
  final ServerNode server;
  final String? localId; // null = this device has not placed the row yet
  final int appliedAt;
}

class Base {
  Base({required this.head, required this.othersId, required this.entries});
  final int head;
  final String othersId;
  final Map<String, BaseEntry> entries; // keyed by server id
}

class TouchEntry {
  TouchEntry({
    required this.at,
    this.removed = false,
    this.title,
    this.url,
    this.tags,
    this.reordered = false,
  });

  final int at; // unix seconds of the edit
  final bool removed;
  final String? title;
  final String? url;
  final List<String>? tags;
  final bool reordered;
}

typedef TouchJournal = Map<String, TouchEntry>;

// ---- planned operations ----

// Local-side op. The TS engine addressed chrome.bookmarks; the app executes
// these against the SQLite mirror. Ops and semantics are identical.
abstract class LocalOp {
  String get serverId;
  String? get localId;
}

class LocalCreate implements LocalOp {
  LocalCreate({
    required this.serverId,
    required this.parentServerId,
    required this.type,
    required this.title,
    this.url,
    required this.index,
  });
  @override
  final String serverId;
  final String parentServerId;
  final String type;
  final String title;
  final String? url;
  final int index;
  @override
  String get localId => serverId; // app-local rows adopt the server id

  @override
  String toString() =>
      'LocalCreate($serverId parent=$parentServerId type=$type title=$title index=$index)';
  @override
  bool operator ==(Object other) =>
      other is LocalCreate &&
      other.serverId == serverId &&
      other.parentServerId == parentServerId &&
      other.type == type &&
      other.title == title &&
      other.url == url &&
      other.index == index;
  @override
  int get hashCode => Object.hash(serverId, parentServerId, type, title, url, index);
}

class LocalUpdate implements LocalOp {
  LocalUpdate({required this.serverId, required this.localId, required this.title, this.url});
  @override
  final String serverId;
  @override
  final String? localId;
  final String title;
  final String? url;

  @override
  String toString() => 'LocalUpdate($serverId/$localId title=$title)';
  @override
  bool operator ==(Object other) =>
      other is LocalUpdate && other.serverId == serverId && other.localId == localId && other.title == title && other.url == url;
  @override
  int get hashCode => Object.hash(serverId, localId, title, url);
}

class LocalMove implements LocalOp {
  LocalMove({
    required this.serverId,
    required this.localId,
    required this.parentServerId,
    required this.index,
  });
  @override
  final String serverId;
  @override
  final String? localId;
  final String parentServerId;
  final int index;

  @override
  String toString() => 'LocalMove($serverId/$localId parent=$parentServerId index=$index)';
  @override
  bool operator ==(Object other) =>
      other is LocalMove &&
      other.serverId == serverId &&
      other.localId == localId &&
      other.parentServerId == parentServerId &&
      other.index == index;
  @override
  int get hashCode => Object.hash(serverId, localId, parentServerId, index);
}

class LocalRemove implements LocalOp {
  LocalRemove({required this.serverId, required this.localId});
  @override
  final String serverId;
  @override
  final String? localId;

  @override
  String toString() => 'LocalRemove($serverId/$localId)';
  @override
  bool operator ==(Object other) => other is LocalRemove && other.serverId == serverId && other.localId == localId;
  @override
  int get hashCode => Object.hash(serverId, localId);
}

// Server-side op (POST /api/sync/apply). One class with optional fields
// mirrors store.BatchOp's merge semantics better than a sealed union here.
class ServerOp {
  ServerOp.create({
    required this.id,
    required this.parentId,
    required this.type,
    required this.title,
    this.url,
    required this.position,
    required this.updatedAt,
    this.tags,
    this.deviceId,
  })  : op = 'create',
        favorite = null,
        undelete = false,
        observedRevision = 0;

  ServerOp.update({
    required this.id,
    this.title,
    this.url,
    this.parentId,
    this.position,
    this.tags,
    this.undelete = false,
    required this.updatedAt,
    int? observedRevision,
    this.deviceId,
  })  : op = 'update',
        type = null,
        favorite = null,
        observedRevision = observedRevision ?? 0;

  ServerOp.delete({required this.id, required this.updatedAt, this.deviceId})
    : op = 'delete',
      type = null,
      parentId = null,
      title = null,
      url = null,
      position = null,
      tags = null,
      favorite = null,
      undelete = false,
      observedRevision = 0;

  final String op; // 'create' | 'update' | 'delete'
  final String id;
  final String? type;
  final String? parentId;
  final String? title;
  final String? url;
  double? position;
  final List<String>? tags;
  final bool? favorite;
  final bool undelete;
  final int updatedAt;
  final int observedRevision;
  final String? deviceId; // stamped by the engine; serialized in toJson()

  /// Merge a swept slot into an existing update op (the sweep merge is the
  /// only mutation — ServerOp is otherwise treated as immutable).
  void setPosition(double slot) => position = slot;

  Map<String, dynamic> toJson([String? deviceIdOverride]) => switch (op) {
        'create' => {
          'op': 'create',
          'id': id,
          'parentId': parentId,
          'type': type,
          'title': title,
          if (url != null && url!.isNotEmpty) 'url': url,
          'position': position,
          if (tags != null && tags!.isNotEmpty) 'tags': tags,
          'updatedAt': updatedAt,
          'deviceId': deviceIdOverride ?? deviceId,
        },
        'update' => {
          'op': 'update',
          'id': id,
          if (title != null) 'title': title,
          if (url != null) 'url': url,
          if (parentId != null) 'parentId': parentId,
          if (position != null) 'position': position,
          if (tags != null) 'tags': tags,
          if (undelete) 'undelete': true,
          'updatedAt': updatedAt,
          'deviceId': deviceIdOverride ?? deviceId,
          'observedRevision': observedRevision,
        },
        _ => {
          'op': 'delete',
          'id': id,
          'updatedAt': updatedAt,
          'deviceId': deviceIdOverride ?? deviceId,
        },
      };

  @override
  String toString() => switch (op) {
        'create' => 'ServerOp.create($id parent=$parentId type=$type title=$title pos=$position)',
        'update' =>
          'ServerOp.update($id title=$title url=$url parent=$parentId pos=$position undelete=$undelete obs=$observedRevision)',
        _ => 'ServerOp.delete($id)',
      };
}

class SyncStats {
  int planned = 0;
  int chromeCreates = 0;
  int chromeUpdates = 0;
  int chromeMoves = 0;
  int chromeRemoves = 0;
  int adopted = 0;
  int pushed = 0;
  int positionPushes = 0;

  @override
  String toString() =>
      'SyncStats(planned=$planned creates=$chromeCreates updates=$chromeUpdates '
      'moves=$chromeMoves removes=$chromeRemoves adopted=$adopted pushed=$pushed posPushes=$positionPushes)';
}

class SyncPlan {
  SyncPlan({
    required this.chromeOps,
    required this.serverOps,
    required this.newBaseEntries,
    required this.stats,
  });

  final List<LocalOp> chromeOps;
  final List<ServerOp> serverOps;
  final Map<String, BaseEntry> newBaseEntries; // keyed by server id
  final SyncStats stats;
}

class PlanInput {
  PlanInput({
    required this.server,
    required this.local,
    this.base,
    required this.touch,
    required this.deviceId,
    required this.now,
    required this.othersId,
  });

  final List<ServerNode> server;
  final List<LocalNode> local;
  final Base? base;
  final TouchJournal touch;
  final String deviceId;
  final int now; // unix seconds
  final String othersId;
}

// ---- helpers ----

/// URL normalization shared by adoption matching: trailing slashes, case,
/// AND percent-encoding are insignificant to bookmark identity (the TS
/// engine's normBookmarkUrl — decode AFTER lowercasing so %2F == %2f).
String normBookmarkUrl(String? raw) {
  if (raw == null || raw.isEmpty) return '';
  var u = raw.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();
  try {
    u = Uri.decodeComponent(u);
    u = u.replaceAll(RegExp(r'/+$'), '').toLowerCase();
  } on ArgumentError {
    // malformed escape: keep as-is (best-effort normalization)
  }
  return u;
}

int _touchAt(TouchJournal touch, String? localId) {
  if (localId == null) return 0;
  return touch[localId]?.at ?? 0;
}

// ---- per-reconcile context ----

class _Ctx {
  _Ctx({
    required this.chromeOps,
    required this.serverOps,
    required this.stats,
    required this.binding,
    required this.reverse,
    required this.serverById,
    required this.localById,
    required this.localChildren,
    required this.serverRank,
    required this.unboundByUrl,
    required this.touch,
    required this.deviceId,
    required this.othersId,
    this.barRootLid,
    this.otherRootLid,
  });

  final List<LocalOp> chromeOps;
  final List<ServerOp> serverOps;
  final SyncStats stats;
  final Map<String, String?> binding; // serverId -> localId as the plan leaves it
  final Map<String, String> reverse; // localId -> serverId
  final Map<String, ServerNode> serverById;
  final Map<String, LocalNode> localById;
  final Map<String, List<LocalNode>> localChildren;
  final Map<String, int> serverRank;
  final Map<String, List<LocalNode>> unboundByUrl;
  final TouchJournal touch;
  final String deviceId;
  final String othersId;
  final String? barRootLid;
  final String? otherRootLid;
  // parents whose child order is re-asserted server-side by this plan's
  // reorder sweep — planPositionOnly suppresses the opposing convergence
  // moves for their children (they would fight the sweep).
  final Set<String> sweptParents = {};
}

/// Plan a reconcile: server ops first (server LWW judges), then local ops.
SyncPlan planSync(PlanInput input) {
  final base = input.base != null && input.base!.head > 0 ? input.base : null;
  final serverById = {for (final n in input.server) n.id: n};
  final localById = {for (final n in input.local) n.id: n};

  final chromeOps = <LocalOp>[];
  final serverOps = <ServerOp>[];
  final stats = SyncStats();

  // serverId -> localId binding as this plan leaves it (seeded from base)
  final binding = <String, String?>{};
  if (base != null) {
    base.entries.forEach((sid, e) => binding[sid] = e.localId);
  }

  // reverse index: localId -> serverId (from base bindings)
  final reverse = <String, String>{};
  binding.forEach((sid, lid) {
    if (lid != null) reverse[lid] = sid;
  });

  // structural binding: app other-bookmarks root ↔ canonical holder
  final otherRootLocal = input.local.where((n) => n.isOtherRoot).firstOrNull;
  if (otherRootLocal != null) {
    binding[input.othersId] = otherRootLocal.id;
    reverse[otherRootLocal.id] = input.othersId;
  }

  final barRootLocal = input.local
      .where((n) => n.parentId.isEmpty && n.type == 'folder' && !identical(n, otherRootLocal))
      .firstOrNull;

  // index local children by parent for move/position planning
  final localChildren = <String, List<LocalNode>>{};
  for (final n in input.local) {
    (localChildren[n.parentId] ??= []).add(n);
  }

  // server children by parent — rank 0..n-1 by position (rank converges;
  // raw positions never do). The canonical holder occupies no slot.
  final serverChildren = <String, List<ServerNode>>{};
  for (final n in input.server) {
    (serverChildren[n.parentId] ??= []).add(n);
  }
  final serverRank = <String, int>{};
  for (final arr in serverChildren.values) {
    arr.sort((a, b) => a.position.compareTo(b.position));
    var rank = 0;
    for (final n in arr) {
      if (n.id == input.othersId) continue;
      serverRank[n.id] = rank++;
    }
  }

  // URL adoption index: unbound local url nodes by normalized url
  final unboundByUrl = <String, List<LocalNode>>{};
  for (final n in input.local) {
    if (n.type != 'url') continue;
    if (reverse.containsKey(n.id)) continue; // already bound via base
    final key = normBookmarkUrl(n.url);
    (unboundByUrl[key] ??= []).add(n);
  }

  final ctx = _Ctx(
    chromeOps: chromeOps,
    serverOps: serverOps,
    stats: stats,
    binding: binding,
    reverse: reverse,
    serverById: serverById,
    localById: localById,
    localChildren: localChildren,
    serverRank: serverRank,
    unboundByUrl: unboundByUrl,
    touch: input.touch,
    deviceId: input.deviceId,
    othersId: input.othersId,
    barRootLid: barRootLocal?.id,
    otherRootLid: otherRootLocal?.id,
  );

  // ---- Pass 0.5: reorder sweep (detection) — see sweepLocalOrder ----
  final sweepPositions = _sweepLocalOrder(ctx, input, base);

  // ---- Pass 1: server-side rows ----
  // Orphan normalization first: a row whose parent id is not itself in the
  // server tree re-parents to top level (matching server Restore semantics).
  final orphanIds = <String>{};
  final normalizedServer = input.server.map((sn) {
    if (sn.parentId.isNotEmpty && !serverById.containsKey(sn.parentId)) {
      orphanIds.add(sn.id);
      return sn.copyWith(parentId: '');
    }
    return sn;
  }).toList();

  for (final sn in normalizedServer) {
    final bEntry = base?.entries[sn.id];
    final localId = binding[sn.id];
    final ln = localId != null ? localById[localId] : null;

    if (bEntry == null) {
      // NEW on the server (was not in base). Bind or create locally.
      // A structurally bound row never creates: the app root IS the bucket.
      if (sn.id == input.othersId && otherRootLocal != null) {
        binding[sn.id] = otherRootLocal.id;
        continue;
      }
      // unbound same-URL local node: adopt it (no duplicate) — the
      // force-resync / first-pair adoption path.
      if (sn.type == 'url') {
        final cand = unboundByUrl[normBookmarkUrl(sn.url)]?.firstOrNull;
        if (cand != null) {
          _adoptBinding(ctx, sn.id, cand, normBookmarkUrl(sn.url));
          // Title divergence on adoption: a journaled local edit NEWER than
          // the server row must PUSH (the pending edit survives forceResync).
          if (cand.title != sn.title) {
            final tt = _touchAt(input.touch, cand.id);
            if (tt > sn.updatedAt) {
              _pushLocalState(ctx, sn, cand, cand.id);
            } else if (input.touch[cand.id] == null) {
              chromeOps.add(LocalUpdate(serverId: sn.id, localId: cand.id, title: sn.title, url: sn.url));
            }
          }
          continue;
        }
      }
      // folders: adopt a same-title unbound folder under the same bound
      // parent (two rebuilds converge on one folder shell). NOT for
      // freshly-journaled local folders on a PAIRED device (pending own
      // create racing another device's create). On a FIRST pair
      // (base == null) every local node is pre-pair content being
      // IMPORTED: touch must NOT block adoption there.
      if (sn.type == 'folder') {
        final parentLid = sn.parentId.isEmpty && barRootLocal != null
            ? barRootLocal.id
            : sn.parentId == input.othersId && otherRootLocal != null
                ? otherRootLocal.id
                : binding[sn.parentId];
        if (parentLid != null) {
          final sibs = localChildren[parentLid] ?? const [];
          final same = sibs
              .where((s) => s.type == 'folder' && s.title == sn.title && !reverse.containsKey(s.id))
              .toList();
          final cand = same.length == 1 ? same.first : null;
          final candTouch = cand != null ? _touchAt(input.touch, cand.id) : 0;
          final serverNewer = sn.updatedAt > candTouch;
          final pendingOwnCreate =
              base != null && cand != null && input.touch[cand.id] != null && !serverNewer;
          if (cand != null && !pendingOwnCreate) {
            _adoptBinding(ctx, sn.id, cand, normBookmarkUrl(cand.url));
            continue;
          }
        }
      }
      chromeOps.add(_createOpFromServerRow(sn));
      continue;
    }

    // row existed in base: three-way compare
    final serverChanged = !_serverEq(bEntry.server, sn);
    final localChanged = ln != null
        ? _localDiffers(ln, bEntry.server, input.touch, localId)
        : true; // null binding = never placed

    if (ln == null) {
      // the local node is gone. Distinguish WHY:
      //  - touch says the user deleted it locally AND newer than the server
      //    row → push the delete (deletes are LWW too; a server RESTORE
      //    bumps updatedAt past the deletion and re-creates locally).
      //  - binding null (never placed) → nothing local to lose.
      //  - otherwise vanished un-journaled → recreate from the server row.
      final tRemoved = localId != null ? (input.touch[localId]?.removed ?? false) : false;
      if (localId != null && tRemoved && (input.touch[localId]!.at > sn.updatedAt)) {
        serverOps.add(ServerOp.delete(id: sn.id, updatedAt: input.touch[localId]!.at));
        stats.pushed++;
        continue;
      }
      if (serverChanged || localId == null) {
        chromeOps.add(_createOpFromServerRow(sn));
      } else {
        // unchanged row whose local node vanished without a journal entry:
        // adopt by URL or recreate
        if (sn.type == 'url') {
          final cand = unboundByUrl[normBookmarkUrl(sn.url)]?.firstOrNull;
          if (cand != null) {
            _adoptBinding(ctx, sn.id, cand, normBookmarkUrl(sn.url));
            continue;
          }
        }
        chromeOps.add(_createOpFromServerRow(sn));
      }
      continue;
    }

    // both sides present
    // ORPHAN REPAIR FIRST: a row whose server parent died converges on the
    // app's healthy placement (push the parent fix) regardless of content.
    if (orphanIds.contains(sn.id)) {
      final localParentSid = reverse[ln.parentId] ?? '';
      serverOps.add(ServerOp.update(
        id: sn.id,
        title: ln.title,
        parentId: localParentSid == input.othersId ? input.othersId : '',
        updatedAt: maxInt(_touchAt(input.touch, localId), input.now),
        deviceId: input.deviceId,
        observedRevision: sn.revision,
      ));
      stats.pushed++;
      continue;
    }
    if (serverChanged && localChanged) {
      // both moved since base: LWW by timestamps (touch time vs server time)
      final t = _touchAt(input.touch, localId);
      if (t > sn.updatedAt) {
        _pushLocalState(ctx, sn, ln, localId);
      } else {
        _planServerToLocal(ctx, sn, ln, localId, serverRank[sn.id] ?? 0);
      }
    } else if (serverChanged) {
      _planServerToLocal(ctx, sn, ln, localId, serverRank[sn.id] ?? 0);
    } else if (localChanged) {
      // Guard against re-pushing DOOMED updates: when the local touch is
      // STRICTLY OLDER than the server row, the local content is STALE —
      // absorb the server state instead of re-pushing forever. EQUAL
      // timestamps still push (the server's observedRevision tie rule lets
      // a legitimate follow-up edit win; resync runs sub-second).
      final t = _touchAt(input.touch, localId);
      if (t < sn.updatedAt) {
        _planServerToLocal(ctx, sn, ln, localId, serverRank[sn.id] ?? 0);
      } else {
        _pushLocalState(ctx, sn, ln, localId);
      }
    } else {
      // convergence check: positions may still drift. Structurally bound
      // rows never move — their app position is the root bucket's own.
      if (sn.id != input.othersId) {
        _planPositionOnly(ctx, sn, ln, localId, serverRank[sn.id] ?? 0);
      }
    }
  }

  // ---- Pass 2: rows in base that the server tree no longer carries ----
  final rebindingEntries = <String, BaseEntry>{};
  if (base != null) {
    base.entries.forEach((sid, entry) {
      if (serverById.containsKey(sid)) return; // handled in pass 1
      final localId = binding[sid] ?? entry.localId;
      final ln = localId != null ? localById[localId] : null;

      // UNCONFIRMED MINTED ROW: revision 0 means the server never accepted
      // this create — a pending local ADDITION, not a server deletion.
      // Re-push with the parent re-rooted to the nearest SURVIVING ancestor.
      if (entry.server.revision == 0 && ln != null) {
        var parentSid = '';
        var anc = entry.server.parentId;
        var depth = 0;
        while (anc.isNotEmpty && depth < 50) {
          if (anc.isEmpty || serverById.containsKey(anc) || anc == input.othersId) {
            parentSid = anc;
            break;
          }
          final baseParent = base.entries[anc];
          if (baseParent != null && baseParent.localId != null && localById.containsKey(baseParent.localId)) {
            anc = baseParent.server.parentId;
          } else {
            break;
          }
          depth++;
        }
        final t = _touchAt(input.touch, localId) != 0
            ? _touchAt(input.touch, localId)
            : entry.server.updatedAt;
        if (entry.server.type == 'url') {
          serverOps.add(ServerOp.create(
            id: sid,
            parentId: parentSid,
            type: 'url',
            title: ln.title,
            url: ln.url ?? '',
            position: (ln.index + 1).toDouble(),
            updatedAt: maxInt(t, entry.server.updatedAt),
          ));
        } else {
          serverOps.add(ServerOp.create(
            id: sid,
            parentId: parentSid,
            type: 'folder',
            title: ln.title,
            position: (ln.index + 1).toDouble(),
            updatedAt: maxInt(t, entry.server.updatedAt),
          ));
        }
        stats.pushed++;
        // keep the minted base entry but refresh the projected parent so a
        // rejected push re-plans identically (re-rooted, never as a delete)
        rebindingEntries[sid] = BaseEntry(
          server: entry.server.copyWith(parentId: parentSid),
          localId: ln.id,
        );
        return;
      }

      // server deleted the row. If the local side edited it after base, the
      // local edit wins: push an undelete-style recreate.
      final t = localId != null ? _touchAt(input.touch, localId) : 0;
      if (ln != null && t > entry.server.updatedAt) {
        serverOps.add(ServerOp.update(
          id: sid,
          title: ln.title,
          url: ln.type == 'url' ? (ln.url ?? '') : null,
          undelete: true,
          updatedAt: t,
          deviceId: input.deviceId,
          observedRevision: entry.server.revision,
        ));
        stats.pushed++;
        return;
      }
      // The undelete push already lost once (t <= updatedAt): deletion wins.
      // Plan the local remove (touch consumed so pass 3 does not resurrect
      // the node as a fresh create — that would ping-pong remove/create).
      if (ln != null && localId != null) {
        chromeOps.add(LocalRemove(serverId: sid, localId: ln.id));
        stats.chromeRemoves++;
        binding.remove(sid);
        return;
      }

      // adoption rescue: an unbound local node with the same URL is the same
      // bookmark re-imported — rebind instead of deleting.
      if (entry.server.type == 'url') {
        final cand = unboundByUrl[normBookmarkUrl(entry.server.url)];
        if (cand != null && cand.isNotEmpty) {
          _adoptBinding(ctx, sid, cand.first, normBookmarkUrl(entry.server.url));
          rebindingEntries[sid] = BaseEntry(server: entry.server, localId: cand.first.id);
          return;
        }
      }

      if (ln != null) {
        chromeOps.add(LocalRemove(serverId: sid, localId: ln.id));
        stats.chromeRemoves++;
      }
      // else: local node already gone — binding just dissolves
      binding.remove(sid);
    });
  }

  // ---- Pass 3: local rows with no server counterpart ----
  final excluded = <String>{};
  if (otherRootLocal != null) excluded.add(otherRootLocal.id);
  final barRootId = barRootLocal?.id;
  for (final n in input.local) {
    if (n.parentId.isEmpty) continue; // root buckets
    if (excluded.contains(n.id)) continue;
    if (reverse.containsKey(n.id)) continue; // bound: handled in pass 1/2
    // parent must resolve to an in-scope ancestor (walk up)
    var anc = n.parentId;
    var resolved = false;
    var depth = 0;
    while (anc.isNotEmpty && depth < 50) {
      if (anc == barRootId || anc == otherRootLocal?.id) {
        resolved = true;
        break;
      }
      if (reverse.containsKey(anc)) {
        resolved = true;
        break;
      }
      anc = localById[anc]?.parentId ?? '';
      depth++;
    }
    if (!resolved) continue; // outside the synced scope
    // unbound local node: mint a server id. In the app the local id IS the
    // server id (we own both), but minting stays content-derived so the
    // plan is stable across re-plans — same contract as the TS engine.
    final touchT = _touchAt(input.touch, n.id);
    final t = touchT != 0
        ? touchT
        : (n.dateAdded != null && n.dateAdded! > 0 ? n.dateAdded! : input.now);
    final minted = mintStableId(n);
    binding[minted] = n.id;
    reverse[n.id] = minted;
    // CRITICAL data-loss guard: the local parent may be bound to a row the
    // server has just deleted. Re-root the create to the nearest ancestor
    // the server still holds so content cannot be destroyed by this race.
    var parentSid = '';
    {
      var ancLid = n.parentId;
      var depth2 = 0;
      while (ancLid.isNotEmpty && depth2 < 50) {
        final sid = reverse[ancLid];
        if (sid != null) {
          if (sid == input.othersId) {
            parentSid = input.othersId;
            break;
          }
          // live on the server, OR minted earlier in THIS pass (parents
          // precede children in the local walk)
          final mintedQueued = serverOps.any((o) => o.op == 'create' && o.id == sid);
          if (serverById.containsKey(sid) || mintedQueued) {
            parentSid = sid;
            break;
          }
          // bound but server-deleted: walk further up the LOCAL chain
          ancLid = localById[ancLid]?.parentId ?? '';
          depth2++;
          continue;
        }
        if (ancLid == barRootId) {
          parentSid = '';
          break;
        }
        if (ancLid == otherRootLocal?.id) {
          parentSid = input.othersId;
          break;
        }
        ancLid = localById[ancLid]?.parentId ?? '';
        depth2++;
      }
    }
    final tags = input.touch[n.id]?.tags;
    if (n.type == 'url') {
      serverOps.add(ServerOp.create(
        id: minted,
        parentId: parentSid,
        type: 'url',
        title: n.title,
        url: n.url ?? '',
        position: (n.index + 1).toDouble(),
        tags: tags,
        updatedAt: t,
      ));
    } else {
      serverOps.add(ServerOp.create(
        id: minted,
        parentId: parentSid,
        type: 'folder',
        title: n.title,
        position: (n.index + 1).toDouble(),
        tags: tags,
        updatedAt: t,
      ));
    }
    stats.pushed++;
  }

  // ---- topology: local creates must be parent-first ----
  final orderedChrome = _topoSortChrome(chromeOps);

  // ---- new base: server tree as-is + bindings established by this plan ----
  final newBaseEntries = <String, BaseEntry>{};
  for (final sn in input.server) {
    newBaseEntries[sn.id] = BaseEntry(server: sn, localId: binding[sn.id]);
  }
  // rows this plan PUSHES as creates (minted ids) must enter the new base
  // too — otherwise the next reconcile re-plans them (duplicate-create churn)
  for (final o in serverOps) {
    if (o.op != 'create') continue;
    if (newBaseEntries.containsKey(o.id)) continue;
    newBaseEntries[o.id] = BaseEntry(
      server: ServerNode(
        id: o.id,
        parentId: o.parentId ?? '',
        type: o.type ?? 'url',
        title: o.title ?? '',
        url: (o.url == null || o.url!.isEmpty) ? null : o.url,
        position: o.position ?? 0,
        revision: 0,
        updatedAt: o.updatedAt,
        deviceId: input.deviceId,
      ),
      localId: binding[o.id],
    );
  }
  newBaseEntries.addAll(rebindingEntries);

  // ---- merge the sweep's target positions into the ops ----
  // One op per row per batch: a row with a content op absorbs its swept
  // position; a row with no content op gets a position-only op. "Needs
  // writing" is judged by RANK, never by the raw position.
  sweepPositions.forEach((sid, slot) {
    final sn = serverById[sid];
    if (sn == null) return;
    final slotChanged = (ctx.serverRank[sid] ?? slot - 1) != slot - 1 ||
        (sn.position - slot).abs() >= 0.0001;
    final existing = serverOps.where((o) => o.op == 'update' && o.id == sid).firstOrNull;
    if (existing != null) {
      // a real drift must survive the merge; an equal-value write would
      // only churn the row's LWW clock
      if (slotChanged) {
        existing.setPosition(slot);
        stats.positionPushes++;
      }
      return;
    }
    if (!slotChanged) return; // already exact on the server
    final localId = binding[sid];
    final t = (localId != null ? (input.touch[localId]?.at ?? 0) : 0) != 0
        ? input.touch[localId]!.at
        : input.now;
    serverOps.add(ServerOp.update(
      id: sid,
      position: slot.toDouble(),
      updatedAt: maxInt(t, input.now),
      deviceId: input.deviceId,
      observedRevision: sn.revision,
    ));
    stats.positionPushes++;
  });

  stats.planned = orderedChrome.length + serverOps.length;
  return SyncPlan(
    chromeOps: orderedChrome,
    serverOps: serverOps,
    newBaseEntries: newBaseEntries,
    stats: stats,
  );
}

// ---- comparison helpers ----

bool _serverEq(ServerNode a, ServerNode b) =>
    a.parentId == b.parentId &&
    a.title == b.title &&
    normBookmarkUrl(a.url) == normBookmarkUrl(b.url) &&
    (a.position - b.position).abs() < 0.0001;

// localDiffers: does the local node look different from what base recorded?
// Server-only fields (note/favorite/archive/tags) must NEVER gate a local
// diff — the app CAN persist them, but the engine contract matches the TS
// engine's chrome.bookmarks surface; server-only fields ride server ops.
bool _localDiffers(LocalNode ln, ServerNode baseServer, TouchJournal touch, String? localId) {
  if (localId == null) return true; // never placed
  if ((touch[localId]?.at ?? 0) != 0) return true; // any journaled edit counts
  if (ln.title != baseServer.title) return true;
  if (normBookmarkUrl(ln.url) != normBookmarkUrl(baseServer.url)) return true;
  return false;
}

// parent-equivalence for placement planning: the local parent matches the
// server parent when the plan's bindings say so. Root buckets are
// structural: '' ↔ bar-root, othersId ↔ other-root. UNDECIDABLE is not
// UNMATCHED: when neither the binding nor a structural root can identify
// the local parent, the check abstains — abstaining never plans a move.
bool? _localParentMatchesServer(LocalNode ln, String snParentId, _Ctx ctx) {
  final lp = ln.parentId;
  if (snParentId.isEmpty && ctx.barRootLid != null) return lp == ctx.barRootLid;
  if (snParentId == ctx.othersId && ctx.otherRootLid != null) return lp == ctx.otherRootLid;
  final bound = ctx.reverse[lp];
  if (bound != null) return bound == snParentId;
  // the local parent is a root bucket but the server parent is a REAL row
  // (or vice versa): a definite mismatch, never an abstention.
  if ((lp == ctx.barRootLid || lp == ctx.otherRootLid) &&
      snParentId.isNotEmpty &&
      snParentId != ctx.othersId) {
    return false;
  }
  return null; // abstain
}

// ---- planning helpers ----

LocalCreate _createOpFromServerRow(ServerNode sn) => LocalCreate(
      serverId: sn.id,
      parentServerId: sn.parentId,
      type: sn.type,
      title: sn.title,
      url: sn.url,
      index: maxInt(0, sn.position.round() - 1),
    );

void _adoptBinding(_Ctx ctx, String sid, LocalNode cand, String urlKey) {
  ctx.binding[sid] = cand.id;
  ctx.reverse[cand.id] = sid;
  ctx.unboundByUrl.remove(urlKey);
  ctx.stats.adopted++;
}

// apply server state to the local tree (update/move/remove-and-recreate).
// URL changes re-materialize the row (matching the TS engine's chrome
// constraint — the app could update in place, but the ops stay identical
// so the differential fixtures hold for both engines).
void _planServerToLocal(_Ctx ctx, ServerNode sn, LocalNode ln, String? localId, int rank) {
  final urlChanged = sn.type == 'url' && normBookmarkUrl(ln.url) != normBookmarkUrl(sn.url);
  if (urlChanged) {
    ctx.chromeOps.add(LocalRemove(serverId: sn.id, localId: localId));
    ctx.stats.chromeRemoves++;
    ctx.chromeOps.add(LocalCreate(
      serverId: sn.id,
      parentServerId: sn.parentId,
      type: 'url',
      title: sn.title,
      url: sn.url,
      index: rank,
    ));
    ctx.stats.chromeCreates++;
    return;
  }
  if (ln.title != sn.title) {
    ctx.chromeOps.add(LocalUpdate(serverId: sn.id, localId: localId, title: sn.title, url: sn.url));
    ctx.stats.chromeUpdates++;
  }
  _planPositionOnly(ctx, sn, ln, localId, rank);
}

void _planPositionOnly(_Ctx ctx, ServerNode sn, LocalNode ln, String? localId, int rank) {
  if (ctx.sweptParents.contains(ln.parentId)) return;
  final parentCheck = _localParentMatchesServer(ln, sn.parentId, ctx);
  final parentMismatch = parentCheck == false; // null = undecidable → abstain
  if (ln.index != rank || parentMismatch) {
    ctx.chromeOps.add(LocalMove(
      serverId: sn.id,
      localId: localId,
      parentServerId: sn.parentId,
      index: rank,
    ));
    ctx.stats.chromeMoves++;
  }
}

// push the local node's content to the server. TITLE is always carried;
// URL rides only on a real difference; position rides only on a parent
// change (within-bucket slots belong to the sweep merge, which sees the
// FULL local sequence).
void _pushLocalState(_Ctx ctx, ServerNode sn, LocalNode ln, String? localId) {
  final touchAt = _touchAt(ctx.touch, localId);
  final t = touchAt != 0 ? touchAt : ((ln.dateAdded ?? 0) > 0 ? ln.dateAdded! : DateTime.now().millisecondsSinceEpoch ~/ 1000);
  final localParentSid = ctx.reverse[ln.parentId];
  final parentChanged = localParentSid != null && localParentSid != sn.parentId;
  final tags = ctx.touch[localId]?.tags;
  final urlChanged = ln.url != null && normBookmarkUrl(ln.url) != normBookmarkUrl(sn.url);
  ctx.serverOps.add(ServerOp.update(
    id: sn.id,
    title: ln.title,
    url: urlChanged ? ln.url : null,
    parentId: parentChanged ? localParentSid : null,
    position: parentChanged ? (ln.index + 1).toDouble() : null,
    tags: (tags != null && tags.isNotEmpty) ? tags : null,
    updatedAt: t,
    deviceId: ctx.deviceId,
    observedRevision: sn.revision,
  ));
  ctx.stats.pushed++;
}

// ---- reorder sweep: local child order → server positions ----

// Detect local reordering and record the new child order for the server.
// Returns target slots (serverId → 1-based slot); the caller merges them
// into the final op set. Preconditions per bucket (all must hold):
//   - real parent in the sync scope;
//   - the local bucket is fully populated (every child bound or pending
//     pass-3 create; every live server child present locally);
//   - the local sequence and the server rank sequence differ;
//   - the touch journal vouches a reorder/move since the last reconcile;
//   - LWW gate: the newest touch beats any sibling edited remotely since
//     base (per-row) and the newest remote edit overall (bucket-level).
Map<String, double> _sweepLocalOrder(
  _Ctx ctx,
  PlanInput input,
  Base? base,
) {
  // bucket the server tree by parent once (rank-ordered)
  final serverKidsByParent = <String, List<ServerNode>>{};
  for (final sn in input.server) {
    (serverKidsByParent[sn.parentId] ??= []).add(sn);
  }
  for (final arr in serverKidsByParent.values) {
    arr.sort((a, b) => a.position.compareTo(b.position));
  }

  // candidate buckets: bar root + other root + every folder bound to a row
  // the current tree still carries
  final buckets = <({String serverParentId, String localParentId})>[];
  if (ctx.barRootLid != null) {
    buckets.add((serverParentId: '', localParentId: ctx.barRootLid!));
  }
  if (ctx.otherRootLid != null) {
    buckets.add((serverParentId: ctx.othersId, localParentId: ctx.otherRootLid!));
  }
  ctx.binding.forEach((sid, lid) {
    if (lid == null) return;
    final sn = ctx.serverById[sid];
    if (sn != null && sn.type == 'folder' && input.server.any((x) => x.id == sid)) {
      buckets.add((serverParentId: sid, localParentId: lid));
    }
  });

  final positions = <String, double>{};
  for (final bucket in buckets) {
    final localKids = [...(ctx.localChildren[bucket.localParentId] ?? const <LocalNode>[])]
      ..sort((a, b) => a.index.compareTo(b.index));
    final serverKids = (serverKidsByParent[bucket.serverParentId] ?? const <ServerNode>[])
        .where((k) => k.id != ctx.othersId)
        .toList();
    if (bucket.serverParentId.isEmpty && localKids.isEmpty) continue;
    if (bucket.serverParentId.isNotEmpty &&
        bucket.serverParentId != ctx.othersId &&
        serverKids.isEmpty &&
        localKids.isEmpty) {
      continue;
    }

    // full-population checks (see the TS engine for the reasoning)
    var complete = true;
    for (final k in localKids) {
      if (ctx.touch[k.id]?.removed ?? false) continue; // pending remove
      if (!ctx.reverse.containsKey(k.id)) continue; // pending create: participates
      final boundSid = ctx.reverse[k.id]!;
      if (!ctx.serverById.containsKey(boundSid)) {
        complete = false; // stale binding
        break;
      }
    }
    if (!complete) continue;
    for (final sk in serverKids) {
      final lid = ctx.binding[sk.id];
      final ln = lid != null ? ctx.localById[lid] : null;
      if (ln == null) {
        // never placed (pass 1 creates — transient) or VACATING (its node
        // was deleted; pass 2 removes both sides — must not block sweep)
        if (lid != null && (ctx.touch[lid]?.removed ?? false)) continue;
        complete = false;
        break;
      }
      if (ln.parentId != bucket.localParentId) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;

    // Touch vouch: reorder journal on the PARENT or a move journal on any
    // CHILD newer than the last successful reconcile.
    final head = base?.head ?? 0;
    var newestTouch = 0;
    var vouched = head > 0 &&
        (ctx.touch[bucket.localParentId]?.reordered ?? false) &&
        (ctx.touch[bucket.localParentId]?.at ?? 0) > 0;
    for (final s in localKids) {
      final t = ctx.touch[s.id]?.at ?? 0;
      if (ctx.touch[s.id]?.removed ?? false) continue; // deleted rows never vouch
      if (t > 0) vouched = vouched || t > 0;
      if (t > newestTouch) newestTouch = t;
    }
    if (!vouched || newestTouch == 0) continue;

    // per-sibling drift over the FULL local sequence
    final sweep = <({ServerNode sn, double slot})>[];
    var driftedCount = 0;
    var target = 0;
    for (final ln in localKids) {
      if (ctx.touch[ln.id]?.removed ?? false) continue; // pending remove: skip slot
      final sid = ctx.reverse[ln.id];
      final sn = sid != null ? ctx.serverById[sid] : null;
      if (sn == null) {
        target++; // pending create: its slot is index+1 via the create op
        continue;
      }
      final drift = target != (ctx.serverRank[sid] ?? target);
      if (drift) driftedCount++;
      sweep.add((sn: sn, slot: (target + 1).toDouble()));
      target++;
    }
    if (driftedCount == 0) continue;

    // LWW gate (sequence-level, two checks)
    var remoteConflictAt = 0;
    var staleSweep = false;
    for (final s in sweep) {
      final baseAt = base?.entries[s.sn.id]?.server.updatedAt ?? 0;
      if (s.sn.updatedAt > baseAt) {
        // remotely edited since base: the drag must be strictly newer
        final lid = ctx.binding[s.sn.id];
        final t = (lid != null ? (ctx.touch[lid]?.at ?? 0) : 0) != 0
            ? ctx.touch[lid]!.at
            : newestTouch;
        if (t <= s.sn.updatedAt) {
          staleSweep = true;
          break;
        }
        if (s.sn.updatedAt > remoteConflictAt) remoteConflictAt = s.sn.updatedAt;
      }
    }
    if (staleSweep) continue;
    if (newestTouch <= remoteConflictAt) continue;

    // re-assert the local order server-side
    for (final s in sweep) {
      positions[s.sn.id] = s.slot;
    }
    ctx.sweptParents.add(bucket.localParentId);
  }
  return positions;
}

// ---- topology: parents before children (local creates) ----

List<LocalOp> _topoSortChrome(List<LocalOp> ops) {
  final creates = ops.whereType<LocalCreate>().toList();
  final others = ops.where((o) => o is! LocalCreate).toList();
  if (creates.isEmpty) return ops;

  // Kahn's algorithm over the create set
  final createByServerId = {for (final c in creates) c.serverId: c};
  final deps = <String, Set<String>>{};
  for (final c in creates) {
    final d = deps[c.serverId] ??= {};
    if (createByServerId.containsKey(c.parentServerId) && c.parentServerId != c.serverId) {
      d.add(c.parentServerId);
    }
  }
  final out = <LocalOp>[];
  final ready = creates.where((c) => (deps[c.serverId]?.length ?? 0) == 0).toList();
  final pending = creates
      .where((c) => (deps[c.serverId]?.length ?? 0) > 0)
      .map((c) => c.serverId)
      .toSet();
  final queue = <LocalCreate>[...ready];
  while (queue.isNotEmpty) {
    final c = queue.removeAt(0);
    out.add(c);
    for (final sid in pending.toList()) {
      final d = deps[sid];
      if (d != null && d.remove(c.serverId) && d.isEmpty) {
        pending.remove(sid);
        queue.add(createByServerId[sid]!);
      }
    }
  }
  if (pending.isNotEmpty) {
    // cycle: cannot happen in a tree, but never hang
    for (final sid in pending) {
      out.add(createByServerId[sid]!);
    }
  }
  return [...out, ...others];
}

// ---- deterministic id minting for local-only rows ----
// The minted id must be STABLE across re-plans (else failed reconciles mint
// a different id each time and the server accumulates ghost rows). Derived
// from content + parent, not from any storage id. Matches the TS engine's
// FNV-1a 64-bit ×2 formatting exactly (differential fixtures rely on it).
String mintStableId(LocalNode n, [String? parentServerId]) {
  final key = '${n.type}|${n.title}|${normBookmarkUrl(n.url)}|${parentServerId ?? n.parentId}|${n.index}';
  return _uuidFromHash(key);
}

String _uuidFromHash(String key) {
  // FNV-1a 64-bit ×2 → 128 bits, formatted as a UUID v4-shaped string.
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  // BigInt(c) on the TS side hashes the FULL code unit value; Dart ints
  // are 64-bit so we XOR the full value too, masking to 32 bits after mul.
  int fnv(int h, int c) {
    h ^= c;
    h = (h * 0x01000193) & 0xFFFFFFFF;
    return h;
  }

  for (var i = 0; i < key.length; i++) {
    h1 = fnv(h1, key.codeUnitAt(i));
    h2 = fnv(h2, key.codeUnitAt(key.length - 1 - i));
  }
  final hex1 = h1.toRadixString(16).padLeft(8, '0');
  final hex2 = h2.toRadixString(16).padLeft(8, '0');
  final hex = (hex1 + hex2).padLeft(32, '0').substring(0, 32);
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-a${hex.substring(17, 20)}-${hex.substring(20, 32)}';
}

// ---- reconnection backoff ----

int backoffDelayMs(int attempt, {double Function() rand = _defaultRand}) {
  final exp = 1000 * _pow2(minInt(attempt, 5));
  final base = exp > 30000 ? 30000 : exp;
  return (base * (0.75 + rand() * 0.5)).round();
}

double _defaultRand() {
  final now = DateTime.now().microsecondsSinceEpoch;
  return (now % 1000) / 1000.0;
}

int _pow2(int n) {
  var r = 1;
  for (var i = 0; i < n; i++) {
    r *= 2;
  }
  return r;
}

int maxInt(int a, int b) => a > b ? a : b;
int minInt(int a, int b) => a < b ? a : b;

// ---- duplicate detection (browser-sync conflict heuristic) ----

class DupGroup {
  DupGroup({required this.title, required this.url, required this.count});
  final String title;
  final String url;
  final int count;
}

List<DupGroup> detectDuplicateGroups(List<({String id, String title, String? url})> nodes) {
  final byKey = <String, ({String title, String url, int count})>{};
  for (final n in nodes) {
    if (n.url == null || n.url!.isEmpty) continue; // folders are not duplicated
    final key = '${n.url!.replaceAll(RegExp(r'/+$'), '').toLowerCase()}|${n.title.trim()}';
    final g = byKey[key];
    if (g != null) {
      byKey[key] = (title: g.title, url: g.url, count: g.count + 1);
    } else {
      byKey[key] = (title: n.title, url: n.url!, count: 1);
    }
  }
  final out = <DupGroup>[];
  byKey.forEach((_, g) {
    if (g.count >= 2) out.add(DupGroup(title: g.title, url: g.url, count: g.count));
  });
  out.sort((a, b) => b.count.compareTo(a.count));
  return out;
}
