import 'dart:convert';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/api/client.dart';
import 'package:markdeck/api/sync_api.dart';
import 'package:markdeck/sync/driver.dart';
import 'package:markdeck/sync/engine.dart';
import 'package:markdeck/store/database.dart';

/// Fake SyncApi: scripted tree/apply responses, records apply batches.
class FakeSyncApi extends SyncApi {
  FakeSyncApi() : super(_FakeClient());

  List<ServerBookmark> nextTree = [];
  final appliedBatches = <List<Map<String, dynamic>>>[];
  int head = 1;
  String othersId = 'md-others';

  @override
  Future<SyncTree> tree() async => SyncTree(
        head: head,
        othersId: othersId,
        nodes: nextTree,
      );

  @override
  Future<ApplyResult> apply(List<Map<String, dynamic>> ops) async {
    appliedBatches.add(ops);
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

  test('first reconcile: empty server + local mirror creates → nothing to push', () async {
    // mirror is empty, server is empty: plan is empty, base advances
    api.nextTree = [];
    await driver.reconcile('test');
    expect(api.appliedBatches, isEmpty);
    expect(driver.status, SyncStatus.online);
    expect(await db.metaInt('head'), 1);
  });

  test('server rows land in the mirror; second reconcile is a fixedpoint', () async {
    api.nextTree = [
      ServerBookmark(
          id: 'f1', parentId: '', type: 'folder', title: 'Tech', position: 1, revision: 5, updatedAt: 1000),
      ServerBookmark(
          id: 'b1',
          parentId: 'f1',
          type: 'url',
          title: 'Go',
          url: 'https://go.dev',
          position: 1,
          revision: 6,
          updatedAt: 1000),
      ServerBookmark(
          id: 'md-others', parentId: '', type: 'folder', title: '其他书签', position: 9999, revision: 7, updatedAt: 1000),
    ];
    await driver.reconcile('first');
    expect(api.appliedBatches, isEmpty, reason: 'import only: server is source of truth');

    final rows = await db.allNodes();
    expect(rows.map((r) => r.id), containsAll(['f1', 'b1', 'md-others']));
    expect(driver.status, SyncStatus.online);

    // second round: fixedpoint — no ops at all
    api.appliedBatches.clear();
    await driver.reconcile('second');
    expect(api.appliedBatches, isEmpty);
    final ops2 = driver.lastStats;
    expect(ops2!.planned, 0);
  });

  test('journaled local edit pushes an update carrying the touch time', () async {
    // seed: server row bound in base
    api.nextTree = [
      ServerBookmark(
          id: 'b1', parentId: '', type: 'url', title: 'Base', url: 'https://x', position: 1, revision: 5, updatedAt: 1000),
      ServerBookmark(
          id: 'md-others', parentId: '', type: 'folder', title: '其他书签', position: 9999, revision: 6, updatedAt: 1000),
    ];
    await driver.reconcile('seed');

    // offline edit: rename in the mirror + journal touch
    await (db.update(db.nodes)..where((n) => n.id.equals('b1')))
        .write(NodesCompanion(title: const Value('Renamed locally')));
    await driver.journalTouch('b1', title: 'Renamed locally');

    api.appliedBatches.clear();
    await driver.reconcile('edit');
    expect(api.appliedBatches, hasLength(1));
    final batch = api.appliedBatches.first;
    expect(batch, hasLength(1));
    expect(batch.first['op'], 'update');
    expect(batch.first['id'], 'b1');
    expect(batch.first['title'], 'Renamed locally');
    expect(batch.first['deviceId'], 'dev-1');
  });

  test('journaled local create pushes a create; mirror row already exists', () async {
    await driver.reconcile('seed-empty');

    // user adds a bookmark locally (mirror row + touch)
    await db.into(db.nodes).insert(NodesCompanion.insert(
          id: 'new-1',
          parentId: const Value(''),
          type: 'url',
          title: 'Added',
          url: const Value('https://added'),
          position: const Value(1.0),
          createdAt: Value(1900),
        ));
    await driver.journalTouch('new-1');

    api.appliedBatches.clear();
    await driver.reconcile('create');
    expect(api.appliedBatches, hasLength(1));
    final op = api.appliedBatches.first.first;
    expect(op['op'], 'create');
    expect(op['title'], 'Added');
    expect(op['url'], 'https://added');
    expect(op['parentId'], ''); // top level → bar bucket
    // touch timestamp wins (journalTouch stamps now); TS engine semantics
    expect((op['updatedAt'] as num).toInt(), greaterThanOrEqualTo(1900));
  });

  test('journaled removal pushes a server delete', () async {
    api.nextTree = [
      ServerBookmark(
          id: 'b1', parentId: '', type: 'url', title: 'Go', url: 'https://go.dev', position: 1, revision: 5, updatedAt: 1000),
      ServerBookmark(
          id: 'md-others', parentId: '', type: 'folder', title: '其他书签', position: 9999, revision: 6, updatedAt: 1000),
    ];
    await driver.reconcile('seed');

    await (db.delete(db.nodes)..where((n) => n.id.equals('b1'))).go();
    await driver.journalTouch('b1', removed: true);

    api.appliedBatches.clear();
    await driver.reconcile('delete');
    expect(api.appliedBatches, hasLength(1));
    final op = api.appliedBatches.first.first;
    expect(op['op'], 'delete');
    expect(op['id'], 'b1');
  });

  test('base persistence round-trip: head + entries survive driver instances', () async {
    api.nextTree = [
      ServerBookmark(
          id: 'f1', parentId: '', type: 'folder', title: 'F', position: 1, revision: 5, updatedAt: 1000),
      ServerBookmark(
          id: 'md-others', parentId: '', type: 'folder', title: '其他书签', position: 9999, revision: 6, updatedAt: 1000),
    ];
    await driver.reconcile('seed');
    final head1 = await db.metaInt('head');

    // fresh driver over the same db: base loads, plan stays empty
    final driver2 = SyncDriver(api: api, db: db, deviceId: 'dev-1', othersId: 'md-others');
    api.appliedBatches.clear();
    await driver2.reconcile('reopen');
    expect(api.appliedBatches, isEmpty);
    expect((driver2.lastStats!).planned, 0);
    expect(await db.metaInt('head'), head1);
  });

  test('json round trip: base serverJson decodes via ServerNode.fromJson', () {
    const j = '{"id":"x1","parentId":"","type":"url","title":"T","url":"https://x",'
        '"position":1.5,"revision":9,"updatedAt":1700,"deviceId":"srv"}';
    final n = ServerNode.fromJson(jsonDecode(j) as Map<String, dynamic>);
    expect(n.id, 'x1');
    expect(n.position, 1.5);
    expect(n.revision, 9);
    final back = n.toJson();
    expect(back['id'], 'x1');
    expect(back['position'], 1.5);
  });
}
