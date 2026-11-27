import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/sync/engine.dart';

// Port of extension/tests/reorder-matrix.test.ts — reorder sweep contract:
//   R1  local drag with touch evidence pushes the whole sibling order
//       server-side (position = index+1); no opposing moves planned
//   R2  fixedpoint: after the sweep lands, re-planning plans ZERO ops
//   R3  no touch evidence (server reordered, local stale) → NO sweep;
//       convergence applies the server order locally
//   R4  LWW gate: a web reorder NEWER than the drag wins
//   R5  LWW gate: a drag NEWER than the web reorder wins
//   R6  scattered server positions with no local edits converge by rank
//   R7  nested-folder drag sweeps only that folder
//   R8  pending unbound child (create-in-set) participates in the sweep
//   R9  rename + drag combined push title and positions consistently
//   R10 other-bookmarks holder bucket sweeps against the canonical holder
//   R11 a failed reconcile re-plans the identical sweep
//   R12 stale touch (already consumed by an advanced base) never loops
//   R13 cross-parent move (bar ↔ others) syncs the new rank
//   R14 pending removals in the bucket make the sweep abstain
//   R15 sweep never clobbers a sibling edited remotely after the drag

int _rev = 100;

ServerNode snRow(
  String id,
  String title,
  String url, {
  String parentId = '',
  required double position,
  required int updatedAt,
  int? revision,
  String type = 'url',
}) {
  _rev++;
  return ServerNode(
    id: id,
    parentId: parentId,
    type: type,
    title: title,
    url: url,
    position: position,
    revision: revision ?? _rev,
    updatedAt: updatedAt,
    deviceId: 'srv',
  );
}

LocalNode lnRow(
  String id,
  String title,
  String url, {
  String parentId = '',
  int index = 0,
  String type = 'url',
  bool isOtherRoot = false,
}) =>
    LocalNode(
      id: id,
      parentId: parentId,
      type: type,
      title: title,
      url: url,
      index: index,
      isOtherRoot: isOtherRoot,
    );

Base makeBase(List<(ServerNode, String?)> entries, [int head = 500]) {
  final e = <String, BaseEntry>{};
  for (final (server, localId) in entries) {
    e[server.id] = BaseEntry(server: server, localId: localId);
  }
  return Base(head: head, othersId: 'md-others', entries: e);
}

PlanInput input({
  List<ServerNode>? server,
  List<LocalNode>? local,
  Base? base,
  TouchJournal? touch,
  String deviceId = 'dev-1',
  int now = 2000,
}) =>
    PlanInput(
      server: server ?? [],
      local: local ?? [],
      base: base,
      touch: touch ?? {},
      deviceId: deviceId,
      now: now,
      othersId: 'md-others',
    );

// standard two-rows-in-bar fixture: server A(1) B(2), local same, bound
List<ServerNode> pairServer() => [
      snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000),
      snRow('b1', 'B', 'https://b', position: 2, updatedAt: 1000),
    ];

List<LocalNode> pairLocal(List<(String, int)> order) => [
      lnRow('bar', '书签栏', '', type: 'folder'),
      ...order.map(((String, int) x) {
        final (id, index) = x;
        return lnRow(id, id == 'a1' ? 'A' : 'B', id == 'a1' ? 'https://a' : 'https://b',
            parentId: 'bar', index: index);
      }),
    ];

Base pairBase() => makeBase([
      (snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000), 'a1'),
      (snRow('b1', 'B', 'https://b', position: 2, updatedAt: 1000), 'b1'),
    ]);

ServerOp? updPos(SyncPlan p, String id) =>
    p.serverOps.where((o) => o.op == 'update' && o.id == id).firstOrNull;

double? posOf(SyncPlan p, String id) => updPos(p, id)?.position;

void main() {
  setUp(() => _rev = 100);

  test('R1: drag pushes the sibling order server-side, no opposing moves', () {
    // local dragged B above A: bar = [B(0), A(1)]; server still A(1) B(2)
    final server = pairServer();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final base = pairBase();
    final touch = {'b1': TouchEntry(at: 1800)}; // onMoved fired for the drag
    final p = planSync(input(server: server, local: local, base: base, touch: touch));

    final pa = updPos(p, 'a1');
    final pb = updPos(p, 'b1');
    expect(pa, isNotNull, reason: 'A must be pushed with position 2');
    expect(pa!.position, 2);
    expect(pb, isNotNull, reason: 'B must be pushed with position 1');
    expect(pb!.position, 1);
    // swept timestamps must pass the server LWW gate (touch > server row)
    expect(pa.updatedAt, greaterThanOrEqualTo(1800));
    // NO local move dragging the bar back to the server order
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
    expect(p.stats.positionPushes, 2);
  });

  test('R1b: sweep ops never rewrite content', () {
    final server = pairServer();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final base = pairBase();
    final p = planSync(input(server: server, local: local, base: base, touch: {'b1': TouchEntry(at: 1800)}));
    for (final o in p.serverOps) {
      // a content op's title must equal what the server already holds
      // (touch-vouched LWW-clock write); a sweep op carries no title
      if (o.title != null) {
        final s = server.where((x) => x.id == o.id).first;
        expect(o.title, s.title);
      }
      expect(o.url, isNull);
    }
  });

  test('R2: fixedpoint after a landed sweep', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1800),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1800),
    ];
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final base = makeBase([for (final s in serverNow) (s, s.id)], 600);
    final p = planSync(input(server: serverNow, local: local, base: base));
    expect(p.serverOps, isEmpty);
    expect(p.chromeOps, isEmpty);
  });

  test('R3: server reorder with no local touch applies server order locally', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1800),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1800),
    ];
    final base = makeBase([
      (snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000), 'a1'),
      (snRow('b1', 'B', 'https://b', position: 2, updatedAt: 1000), 'b1'),
    ]);
    final local = pairLocal([('a1', 0), ('b1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base));
    expect(p.serverOps, isEmpty, reason: 'never re-assert a stale order');
    final moves = p.chromeOps.whereType<LocalMove>().toList();
    expect(moves, isNotEmpty, reason: 'bar absorbs the server order');
    // after the moves execute, the next plan is a fixedpoint
    final localAfter = pairLocal([('b1', 0), ('a1', 1)]);
    final p2 = planSync(input(
      server: serverNow,
      local: localAfter,
      base: makeBase([for (final s in serverNow) (s, s.id)], 600),
    ));
    expect(p2.serverOps, isEmpty);
    expect(p2.chromeOps, isEmpty);
  });

  test('R4: web reorder newer than the drag — bar absorbs the server order', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1900),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1900),
    ];
    final base = pairBase();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base, touch: {'b1': TouchEntry(at: 1500)}));
    expect(p.serverOps, isEmpty, reason: 'stale drag loses');
    expect(p.chromeOps, isEmpty, reason: 'bar order already matches');
  });

  test('R5: drag newer than the web reorder — sweep re-asserts the bar order', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1200),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1200),
    ];
    final base = makeBase([for (final s in serverNow) (s, s.id)], 550);
    final local = pairLocal([('a1', 0), ('b1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base, touch: {'b1': TouchEntry(at: 1800)}));
    expect(posOf(p, 'a1'), 1);
    expect(posOf(p, 'b1'), 2);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('R5b: tie (touch == newest server updatedAt) — sweep abstains', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1800),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1800),
    ];
    final base = pairBase();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base, touch: {'b1': TouchEntry(at: 1800)}));
    expect(p.serverOps, isEmpty);
  });

  test('R6: scattered server positions with no local edits converge by rank', () {
    final server = [
      snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000),
      snRow('b1', 'B', 'https://b', position: 2, updatedAt: 1000),
      snRow('c1', 'C', 'https://c', position: 10000, updatedAt: 1500),
    ];
    final base = makeBase([(server[0], 'a1'), (server[1], 'b1')]);
    final local = pairLocal([('a1', 0), ('b1', 1)]);
    final p = planSync(input(server: server, local: local, base: base));
    expect(p.serverOps, isEmpty, reason: 'no sweep without touch evidence');
    expect(p.chromeOps.whereType<LocalCreate>().any((o) => o.serverId == 'c1'), isTrue);
  });

  test('R7: nested-folder drag sweeps only that folder', () {
    final server = [
      snRow('f1', 'F', '', type: 'folder', position: 1, updatedAt: 1000),
      snRow('x1', 'Xbar', 'https://x', position: 2, updatedAt: 1000),
      snRow('c1', 'C', 'https://c', parentId: 'f1', position: 1, updatedAt: 1000),
      snRow('c2', 'D', 'https://d', parentId: 'f1', position: 2, updatedAt: 1000),
    ];
    final base = makeBase([for (final s in server) (s, s.id)], 500);
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('f1', 'F', '', type: 'folder', parentId: 'bar', index: 0),
      lnRow('x1', 'Xbar', 'https://x', parentId: 'bar', index: 1),
      lnRow('c2', 'D', 'https://d', parentId: 'f1', index: 0),
      lnRow('c1', 'C', 'https://c', parentId: 'f1', index: 1),
    ];
    final p = planSync(input(server: server, local: local, base: base, touch: {'c2': TouchEntry(at: 1800)}));
    // positions pushed for BOTH f1 children (full permutation)
    expect(posOf(p, 'c1'), 2);
    expect(posOf(p, 'c2'), 1);
    // bar-level rows untouched (already aligned)
    expect(updPos(p, 'x1'), isNull);
    expect(updPos(p, 'f1'), isNull);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('R8: appended unbound node pushes as a create; bound siblings untouched', () {
    final server = pairServer();
    final base = pairBase();
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('a1', 'A', 'https://a', parentId: 'bar', index: 0),
      lnRow('b1', 'B', 'https://b', parentId: 'bar', index: 1),
      lnRow('new1', 'New', 'https://new', parentId: 'bar', index: 2),
    ];
    final p = planSync(input(server: server, local: local, base: base, touch: {'new1': TouchEntry(at: 1801)}));
    final createOp = p.serverOps.where((o) => o.op == 'create').firstOrNull;
    expect(createOp, isNotNull);
    expect(createOp!.position, 3, reason: 'index 2 → position 3, slot preserved');
    // NO position ops; no local moves
    expect(p.serverOps.where((o) => o.op == 'update' && o.position != null), isEmpty);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('R8b: drag below a mid-inserted unbound node renumbers around the new slot', () {
    final server = pairServer(); // A(1), B(2)
    final base = pairBase();
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('new1', 'New', 'https://new', parentId: 'bar', index: 0),
      lnRow('b1', 'B', 'https://b', parentId: 'bar', index: 1),
      lnRow('a1', 'A', 'https://a', parentId: 'bar', index: 2),
    ];
    final p = planSync(input(server: server, local: local, base: base, touch: {'new1': TouchEntry(at: 1800)}));
    final createOp = p.serverOps.where((o) => o.op == 'create').firstOrNull;
    expect(createOp, isNotNull, reason: 'New pushes as create at slot 1');
    expect(createOp!.position, 1);
    // A's slot moved 1→3 (after B): the sweep renumbers it
    expect(posOf(p, 'a1'), 3);
    // B stays at slot 2: no op
    expect(updPos(p, 'b1'), isNull);
  });

  test('R9: rename + drag push title and positions consistently', () {
    final server = pairServer();
    final base = pairBase();
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('b1', 'B-renamed', 'https://b', parentId: 'bar', index: 0),
      lnRow('a1', 'A', 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(input(server: server, local: local, base: base, touch: {'b1': TouchEntry(at: 1800)}));
    final pb = updPos(p, 'b1');
    expect(pb, isNotNull, reason: 'renamed row pushes');
    expect(pb!.title, 'B-renamed');
    expect(pb.position, 1);
    expect(posOf(p, 'a1'), 2);
  });

  test('R10: other-bookmarks bucket sweeps against the canonical holder', () {
    final server = [
      snRow('md-others', '其他书签', '', type: 'folder', position: 9999, updatedAt: 1000),
      snRow('o1', 'O1', 'https://o1', parentId: 'md-others', position: 1, updatedAt: 1000),
      snRow('o2', 'O2', 'https://o2', parentId: 'md-others', position: 2, updatedAt: 1000),
    ];
    final base = makeBase([
      (server[0], 'other-root'),
      (server[1], 'o1'),
      (server[2], 'o2'),
    ], 500);
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('other-root', '其他书签', '', type: 'folder', isOtherRoot: true),
      lnRow('o2', 'O2', 'https://o2', parentId: 'other-root', index: 0),
      lnRow('o1', 'O1', 'https://o1', parentId: 'other-root', index: 1),
    ];
    final p = planSync(input(server: server, local: local, base: base, touch: {'o2': TouchEntry(at: 1800)}));
    expect(posOf(p, 'o2'), 1);
    expect(posOf(p, 'o1'), 2);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('R11: a failed reconcile re-plans the identical sweep', () {
    final server = pairServer();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final base = pairBase();
    final touch = {'b1': TouchEntry(at: 1800)};
    final p1 = planSync(input(server: server, local: local, base: base, touch: touch));
    final p2 = planSync(input(server: server, local: local, base: base, touch: touch));
    expect(p1.serverOps.length, greaterThan(0));
    expect(p2.serverOps.length, p1.serverOps.length);
    for (var i = 0; i < p1.serverOps.length; i++) {
      expect(p2.serverOps[i].id, p1.serverOps[i].id);
      expect(p2.serverOps[i].position, p1.serverOps[i].position);
      expect(p2.serverOps[i].updatedAt, p1.serverOps[i].updatedAt);
    }
  });

  test('R12: stale touch (already consumed by an advanced base) never loops', () {
    final serverNow = [
      snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1900),
      snRow('a1', 'A', 'https://a', position: 2, updatedAt: 1900),
    ];
    final base = makeBase([for (final s in serverNow) (s, s.id)], 600);
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base, touch: {'b1': TouchEntry(at: 1500)}));
    expect(p.serverOps, isEmpty);
    expect(p.chromeOps, isEmpty);
  });

  test('R13: cross-parent move (bar → others) syncs the new rank', () {
    final server = [
      snRow('md-others', '其他书签', '', type: 'folder', position: 9999, updatedAt: 1000),
      snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000),
      snRow('b1', 'B', 'https://b', position: 2, updatedAt: 1000),
      snRow('o1', 'O1', 'https://o1', parentId: 'md-others', position: 1, updatedAt: 1000),
    ];
    final base = makeBase([
      (server[0], 'other-root'),
      (server[1], 'a1'),
      (server[2], 'b1'),
      (server[3], 'o1'),
    ], 500);
    final local = [
      lnRow('bar', '书签栏', '', type: 'folder'),
      lnRow('other-root', '其他书签', '', type: 'folder', isOtherRoot: true),
      lnRow('b1', 'B', 'https://b', parentId: 'bar', index: 0),
      lnRow('o1', 'O1', 'https://o1', parentId: 'other-root', index: 0),
      lnRow('a1', 'A', 'https://a', parentId: 'other-root', index: 1),
    ];
    final touch = {'a1': TouchEntry(at: 1800)}; // onMoved fired for A
    final p = planSync(input(server: server, local: local, base: base, touch: touch));
    final pa = p.serverOps.where((o) => o.op == 'update' && o.id == 'a1').firstOrNull;
    expect(pa, isNotNull, reason: 'A pushes its move');
    expect(pa!.parentId, 'md-others');
    expect(pa.position, 2);
  });

  test('R14: pending removals in the bucket make the sweep abstain', () {
    // base had a1+b1; server deleted a1; bar dragged B up meanwhile
    final server = [snRow('b1', 'B', 'https://b', position: 1, updatedAt: 1000)];
    final base = pairBase();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final touch = {'b1': TouchEntry(at: 1800)};
    final p = planSync(input(server: server, local: local, base: base, touch: touch));
    // a1 must be removed locally (server deleted it)
    expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'a1'), isTrue);
    // NO position push: bucket membership is transient (remove pending)
    expect(p.serverOps.where((o) => o.op == 'update' && o.position != null), isEmpty);
  });

  test('R15: sweep never clobbers a sibling edited remotely after the drag', () {
    // server renamed B → 'B-web' at 1900 (after the drag at 1800)
    final serverNow = [
      snRow('a1', 'A', 'https://a', position: 1, updatedAt: 1000),
      snRow('b1', 'B-web', 'https://b', position: 2, updatedAt: 1900),
    ];
    final base = pairBase();
    final local = pairLocal([('b1', 0), ('a1', 1)]);
    final p = planSync(input(server: serverNow, local: local, base: base, touch: {'b1': TouchEntry(at: 1800)}));
    // the sweep abstains entirely: server row newer than the newest touch
    expect(p.serverOps.where((o) => o.op == 'update' && o.position != null), isEmpty);
  });
}
