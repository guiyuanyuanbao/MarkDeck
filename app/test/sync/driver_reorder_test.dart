import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/api/client.dart';
import 'package:markdeck/api/sync_api.dart';
import 'package:markdeck/sync/driver.dart';
import 'package:markdeck/store/database.dart';

/// Driver-level reorder regression (UI 路径的镜像端): the reorder UI rewrites
/// mirror positions/parent FIRST, then journals; the sweep must turn that
/// into position-only pushes. Engine-level semantics live in
/// reorder_matrix_test.dart (R1-R15) — here we pin the wire behavior the
/// drag gesture depends on. Harness mirrors driver_test.dart.
class FakeSyncApi extends SyncApi {
  FakeSyncApi() : super(_FakeClient());

  List<ServerBookmark> nextTree = [];
  final appliedBatches = <List<Map<String, dynamic>>>[];
  int head = 1;
  String othersId = 'md-others';

  @override
  Future<SyncTree> tree() async => SyncTree(head: head, othersId: othersId, nodes: nextTree);

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

  Future<void> seedTwoAtBarRoot() async {
    api.nextTree = [
      ServerBookmark(
          id: 'a', parentId: '', type: 'url', title: 'A', url: 'https://a', position: 1, revision: 5, updatedAt: 1000),
      ServerBookmark(
          id: 'b', parentId: '', type: 'url', title: 'B', url: 'https://b', position: 2, revision: 6, updatedAt: 1000),
      ServerBookmark(
          id: 'md-others', parentId: '', type: 'folder', title: '其他书签', position: 9999, revision: 7, updatedAt: 1000),
    ];
    await driver.reconcile('seed');
    api.appliedBatches.clear();
  }

  test('local sibling reorder: mirror rewrite + journal → position-only pushes', () async {
    await seedTwoAtBarRoot();

    // drag B above A: the UI rewrites the whole bucket 1..n, then journals
    await (db.update(db.nodes)..where((n) => n.id.equals('b')))
        .write(NodesCompanion(position: const Value(1.0)));
    await (db.update(db.nodes)..where((n) => n.id.equals('a')))
        .write(NodesCompanion(position: const Value(2.0)));
    await driver.journalTouch('b');
    await driver.journalReorder('root'); // bar-root bucket key (synthetic parent)

    await driver.reconcile('reorder');
    expect(api.appliedBatches, hasLength(1));
    final ops = api.appliedBatches.first;
    expect(ops, hasLength(2));
    final byId = {for (final op in ops) op['id'] as String: op};
    expect(byId['a']!['position'], 2.0);
    expect(byId['b']!['position'], 1.0);
    // 'a' (untouched) is a pure sweep op — no content rides along; 'b' may
    // carry its touch-vouched LWW-clock title (== server-held value). URL
    // never rides on update ops (R1b).
    expect(byId['a']!['title'], isNull);
    if (byId['b']!['title'] != null) {
      expect(byId['b']!['title'], 'B');
    }
    for (final op in ops) {
      expect(op['url'], isNull);
    }
    expect(driver.lastStats!.positionPushes, 2);

    // fixedpoint: the next reconcile plans nothing
    api.appliedBatches.clear();
    await driver.reconcile('fixed');
    expect(api.appliedBatches, isEmpty);
  });

  test('local move-into folder: parent rewrite + child touch → update with parentId', () async {
    await seedTwoAtBarRoot();

    // drag B onto folder f1: UI writes parentId + tail position, journals
    api.nextTree = api.nextTree
        .map((n) => n.id == 'md-others'
            ? ServerBookmark(
                id: 'f1', parentId: '', type: 'folder', title: 'Tech', position: 3, revision: 8, updatedAt: 1000)
            : n)
        .toList();
    await driver.reconcile('reseed-folder');
    api.appliedBatches.clear();

    await (db.update(db.nodes)..where((n) => n.id.equals('b'))).write(const NodesCompanion(
      parentId: Value('f1'),
      position: Value(1.0),
    ));
    await driver.journalTouch('b');

    await driver.reconcile('move');
    expect(api.appliedBatches, hasLength(1));
    final op = api.appliedBatches.first.first;
    expect(op['op'], 'update');
    expect(op['id'], 'b');
    expect(op['parentId'], 'f1');
  });
}
