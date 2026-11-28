import 'dart:convert';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/api/client.dart';
import 'package:markdeck/api/sync_api.dart';
import 'package:markdeck/sync/driver.dart';
import 'package:markdeck/sync/engine.dart';
import 'package:markdeck/store/database.dart' hide BaseEntry;

/// Ghost-folder storm regression (z 文件夹风暴): App-created rows keep their
/// own local id (timestamp-hash format, NOT the minted server id). The base
/// must persist that binding — before the localId column existed, every
/// reconcile re-minted a fresh create and the server accumulated duplicate
/// folders. Harness mirrors driver_test.dart, with a fake server whose tree
/// reflects successful applies like a real one.
class FakeSyncApi extends SyncApi {
  FakeSyncApi() : super(_FakeClient());

  List<ServerBookmark> nextTree = [];
  final appliedBatches = <List<Map<String, dynamic>>>[];
  int head = 1;
  String othersId = 'md-others';

  @override
  Future<SyncTree> tree() async {
    return SyncTree(head: head, othersId: othersId, nodes: nextTree);
  }

  @override
  Future<ApplyResult> apply(List<Map<String, dynamic>> ops) async {
    appliedBatches.add(ops);
    // a REAL server reflects successful ops into its tree — the fake must do
    // the same or "create landed but tree query says otherwise" false storms
    // appear (the real server's apply is transactional and authoritative)
    for (final op in ops) {
      final id = op['id'] as String;
      switch (op['op']) {
        case 'create':
          nextTree = [
            ...nextTree.where((n) => n.id != id),
            ServerBookmark(
              id: id,
              parentId: op['parentId'] as String? ?? '',
              type: op['type'] as String? ?? 'url',
              title: op['title'] as String? ?? '',
              url: op['url'] as String?,
              position: (op['position'] as num?)?.toDouble() ?? 0,
              revision: head,
              updatedAt: (op['updatedAt'] as num?)?.toInt() ?? 0,
              deviceId: op['deviceId'] as String?,
            ),
          ];
        case 'update':
          nextTree = [
            for (final n in nextTree)
              if (n.id == id)
                ServerBookmark(
                  id: n.id,
                  parentId: op['parentId'] as String? ?? n.parentId,
                  type: n.type,
                  title: op['title'] as String? ?? n.title,
                  url: op['url'] as String? ?? n.url,
                  position: (op['position'] as num?)?.toDouble() ?? n.position,
                  revision: head,
                  updatedAt: (op['updatedAt'] as num?)?.toInt() ?? n.updatedAt,
                  deviceId: op['deviceId'] as String?,
                )
              else
                n,
          ];
        case 'delete':
          nextTree = nextTree.where((n) => n.id != id).toList();
      }
    }
    head += ops.length;
    return ApplyResult(results: const [], head: head);
  }
}

class _FakeClient extends ApiClient {}

void main() {
  late AppDatabase db;
  late FakeSyncApi api;
  late SyncDriver driver;

  setUp(() async {
    db = AppDatabase(NativeDatabase.memory());
    await db.customStatement('PRAGMA foreign_keys = OFF');
    api = FakeSyncApi();
    driver = SyncDriver(api: api, db: db, deviceId: 'dev-1', othersId: 'md-others');
  });

  tearDown(() async => db.close());

  List<Map<String, dynamic>> zCreates() => [
        for (final batch in api.appliedBatches)
          for (final op in batch)
            if (op['op'] == 'create' && op['title'] == 'z') op,
      ];

  test('App-created folder: create pushed once, binding persists, no storm', () async {
    // seed: server has one url (the "网页" the user will drag into z) + holder
    api.nextTree = [
      ServerBookmark(
          id: 'u1',
          parentId: '',
          type: 'url',
          title: '网页',
          url: 'https://page',
          position: 1,
          revision: 5,
          updatedAt: 1000),
      ServerBookmark(
          id: 'md-others',
          parentId: '',
          type: 'folder',
          title: '其他书签',
          position: 9999,
          revision: 6,
          updatedAt: 1000),
    ];
    await driver.reconcile('seed');
    api.appliedBatches.clear();

    // user creates folder z — App rows carry their OWN id format
    const localZId = 'i5z3kxx-f1a2b';
    await db.into(db.nodes).insert(NodesCompanion.insert(
          id: localZId,
          parentId: const Value(''),
          type: 'folder',
          title: 'z',
          position: const Value(2.0),
          createdAt: Value(1900),
        ));
    await driver.journalTouch(localZId);

    // reconcile #1: the create is pushed with the minted server id
    await driver.reconcile('create-z');
    expect(api.appliedBatches, hasLength(1));
    final createOp = api.appliedBatches.first.first;
    expect(createOp['op'], 'create');
    expect(createOp['title'], 'z');
    final mintedSid = createOp['id'] as String;
    expect(mintedSid, isNot(localZId), reason: 'minted id differs from the local row id');

    // THE FIX: the base persists localId == the App-created row id
    final baseRow = await (db.select(db.baseEntries)
          ..where((b) => b.serverId.equals(mintedSid)))
        .getSingleOrNull();
    expect(baseRow, isNotNull, reason: 'minted create must enter the base');
    expect(baseRow!.localId, localZId,
        reason: 'without the persisted binding the next reconcile re-mints '
            'a fresh create and the server accumulates ghost folders');

    // reconcile #2 (the storm trigger: any later reconcile, e.g. the drag
    // touch that follows): must NOT re-create z
    api.appliedBatches.clear();
    await driver.reconcile('later');
    expect(zCreates(), isEmpty, reason: 'ghost-folder storm: z re-created every reconcile');
  });

  test('drag a server-bound url into an App-created folder converges without storms',
      () async {
    api.nextTree = [
      ServerBookmark(
          id: 'u1',
          parentId: '',
          type: 'url',
          title: '网页',
          url: 'https://page',
          position: 1,
          revision: 5,
          updatedAt: 1000),
      ServerBookmark(
          id: 'md-others',
          parentId: '',
          type: 'folder',
          title: '其他书签',
          position: 9999,
          revision: 6,
          updatedAt: 1000),
    ];
    await driver.reconcile('seed');
    const localZId = 'i5z3kxx-f1a2b';
    await db.into(db.nodes).insert(NodesCompanion.insert(
          id: localZId,
          parentId: const Value(''),
          type: 'folder',
          title: 'z',
          position: const Value(2.0),
          createdAt: Value(1900),
        ));
    await driver.journalTouch(localZId);
    await driver.reconcile('create-z');
    api.appliedBatches.clear();

    // the server now holds z (FakeSyncApi.apply reflected the create into
    // its tree, like a real server would) — discover the minted id
    final zBase = await (db.select(db.baseEntries)
          ..where((b) => b.localId.equals(localZId)))
        .getSingle();
    final zSid = zBase.serverId;

    // user drags 网页 into z: mirror parent rewrite + touch (drag-into path)
    await (db.update(db.nodes)..where((n) => n.id.equals('u1')))
        .write(NodesCompanion(parentId: const Value(localZId)));
    await driver.journalTouch('u1');

    // several reconciles in a row (navigation triggers these) — the move
    // lands once, then fixedpoint; z is never duplicated
    for (var i = 0; i < 3; i++) {
      await driver.reconcile('nav-$i');
    }
    expect(zCreates(), isEmpty, reason: 'storm check across repeated reconciles');
    final moves = [
      for (final batch in api.appliedBatches)
        for (final op in batch)
          if (op['op'] == 'update' && op['id'] == 'u1') op,
    ];
    expect(moves, hasLength(1), reason: 'the parent move pushes exactly once');
    expect(moves.first['parentId'], zSid, reason: 'url lands inside z (server id)');
    expect(moves.first['localId'], isNull, reason: 'wire ops carry no local ids');
  });

  test('legacy broken state (unbound App row + server ghosts) converges: exactly one create, then fixedpoint',
      () async {
    // 存量损坏模拟：升级修复版前，用户镜像里有一个从未绑定成功的 z
    // （时间戳 id），服务端已经有 3 个 ghost z。修复版首次 reconcile：
    // 恰好补 1 个 create（绑定从此持久），之后不再增长。
    api.nextTree = [
      ServerBookmark(
          id: 'g1',
          parentId: '',
          type: 'folder',
          title: 'z',
          position: 4,
          revision: 27,
          updatedAt: 1795880472,
          deviceId: 'dev-1'),
      ServerBookmark(
          id: 'g2',
          parentId: '',
          type: 'folder',
          title: 'z',
          position: 3,
          revision: 30,
          updatedAt: 1795880472,
          deviceId: 'dev-1'),
      ServerBookmark(
          id: 'g3',
          parentId: '',
          type: 'folder',
          title: 'z',
          position: 2,
          revision: 31,
          updatedAt: 1795880472,
          deviceId: 'dev-1'),
      ServerBookmark(
          id: 'md-others',
          parentId: '',
          type: 'folder',
          title: '其他书签',
          position: 10001,
          revision: 10,
          updatedAt: 1795870693,
          deviceId: 'web'),
    ];
    // mirrors the damaged device: 3 absorbed ghosts + the never-bound local row
    await driver.reconcile('absorb-ghosts');
    const localZId = 'i5z3kxx-f1a2b';
    await db.into(db.nodes).insert(NodesCompanion.insert(
          id: localZId,
          parentId: const Value(''),
          type: 'folder',
          title: 'z',
          position: const Value(1.0),
          createdAt: Value(1900),
        ));
    // no touch: the row was created long ago, its journal entry long consumed
    api.appliedBatches.clear();

    // 直接复刻 upgrade-1 的输入构造（base 不含 z 条目、本地含未绑定 z），
    // 实证 pass-3 的行为与异常
    final src = LocalTreeSource(db);
    final localNodes = await src.load('md-others');
    final baseRows = await db.select(db.baseEntries).get();
    final entries = <String, BaseEntry>{};
    for (final r in baseRows) {
      entries[r.serverId] = BaseEntry(
        server: ServerNode.fromJson(
            const JsonDecoder().convert(r.serverJson) as Map<String, dynamic>),
        localId: r.localId,
        appliedAt: r.appliedAt,
      );
    }
    try {
      final diagPlan = planSync(PlanInput(
        server: [
          for (final b in api.nextTree)
            ServerNode(
                id: b.id,
                parentId: b.parentId,
                type: b.type,
                title: b.title,
                url: b.url,
                position: b.position,
                revision: b.revision,
                updatedAt: b.updatedAt,
                deviceId: b.deviceId),
        ],
        local: localNodes,
        base: Base(head: 1, othersId: 'md-others', entries: entries),
        touch: const {},
        deviceId: 'dev-1',
        othersId: 'md-others',
        now: 1795882000,
      ));
      // ignore: avoid_print
      print('DIAG upgrade-1 plan ops=${diagPlan.serverOps.map((o) => o.toString()).toList()}');
      // ignore: avoid_print
      print('DIAG upgrade-1 chromeOps=${diagPlan.chromeOps.map((o) => o.toString()).toList()}');
    } catch (e, st) {
      // ignore: avoid_print
      print('DIAG upgrade-1 planSync THREW: $e\n$st');
    }

    await driver.reconcile('upgrade-1');
    final baseRow = await (db.select(db.baseEntries)
          ..where((b) => b.localId.equals(localZId)))
        .getSingleOrNull();
    expect(baseRow, isNotNull, reason: 'upgrade create must bind');
    expect(baseRow!.localId, localZId,
        reason: 'binding must persist the App row id (else the storm continues)');

    for (var i = 0; i < 3; i++) {
      api.appliedBatches.clear();
      await driver.reconcile('upgrade-stable-$i');
      expect(driver.status, SyncStatus.online,
          reason: 'stable-$i must not leave the driver broken');
      expect(zCreates(), isEmpty,
          reason: 'stable-$i must not re-create z (storm dead)');
    }
  });
}
