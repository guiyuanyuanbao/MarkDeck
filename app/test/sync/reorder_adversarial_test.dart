import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/sync/engine.dart';

// Port of extension/tests/reorder-adversarial.test.ts — attacks the sweep's
// edge paths: orphan rows, duplicate positions, empty buckets, pending
// creates mid-sweep, removals racing a drag, cross-root moves, clock skew,
// multi-bucket interaction, and the holder-row exclusion.

int _rev = 100;

ServerNode snA(
  String id,
  String type,
  String title, {
  String parentId = '',
  String? url,
  double position = 1,
  int? revision,
  int updatedAt = 1000,
  String deviceId = 'srv',
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
    deviceId: deviceId,
  );
}

LocalNode lnA(
  String id,
  String type,
  String title, {
  String parentId = '',
  String? url,
  int index = 0,
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

Base mkBase(List<(ServerNode, String?)> entries, [int head = 500]) {
  final e = <String, BaseEntry>{};
  for (final (server, localId) in entries) {
    e[server.id] = BaseEntry(server: server, localId: localId);
  }
  return Base(head: head, othersId: 'md-others', entries: e);
}

PlanInput inp({
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

double? posOf(SyncPlan p, String id) => p.serverOps
    .where((o) => o.op == 'update' && o.id == id && o.position != null)
    .firstOrNull
    ?.position;

void main() {
  setUp(() => _rev = 100);

  test('A1: orphan row repair carries the sweep position — one op total', () {
    final live1 = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final orphan = snA('orph', 'url', 'Orphan',
        url: 'https://o', parentId: 'f1-dead', position: 1, updatedAt: 1000);
    final base = mkBase([
      (live1, 'la'),
      (orphan.copyWith(parentId: ''), 'lo'), // base saw it at top level
    ]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('la', 'url', 'A', url: 'https://a', parentId: 'bar', index: 0),
      lnA('lo', 'url', 'Orphan', url: 'https://o', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: [live1, orphan], local: local, base: base, touch: {'lo': TouchEntry(at: 1800)}));
    final ops = p.serverOps.where((o) => o.op == 'update' && o.id == 'orph').toList();
    expect(ops, hasLength(1), reason: 'exactly one op for the orphan');
    expect(ops.first.parentId, '', reason: 'parent fixed to top level');
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('A2: duplicate raw positions — rank distinguishes, sweep normalizes', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 5, revision: 10);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 5, revision: 11);
    final server = [a, b];
    final base = mkBase([for (final s in server) (s, s.id)]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1800)}));
    expect(posOf(p, 'b'), 1);
    expect(posOf(p, 'a'), 2);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
    // fixedpoint: server normalized, bar unchanged → zero ops
    final serverNow = [
      snA('a', 'url', 'A', url: 'https://a', position: 2, updatedAt: 1800, revision: 20),
      snA('b', 'url', 'B', url: 'https://b', position: 1, updatedAt: 1800, revision: 21),
    ];
    final p2 = planSync(inp(
      server: serverNow,
      local: local,
      base: mkBase([for (final s in serverNow) (s, s.id)], 600),
    ));
    expect(p2.serverOps, isEmpty);
    expect(p2.chromeOps, isEmpty);
  });

  test('A3: empty buckets never plan position ops', () {
    final holder = snA('md-others', 'folder', '其他书签', position: 9999);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('oroot', 'folder', '其他书签', isOtherRoot: true),
    ];
    final base = mkBase([(holder, 'oroot')], 500);
    final p = planSync(inp(
      server: [holder],
      local: local,
      base: base,
      touch: {'oroot': TouchEntry(at: 1800, title: '其他书签')},
    ));
    expect(p.serverOps.where((o) => o.position != null), isEmpty);
    expect(p.chromeOps, isEmpty);
  });

  test('A4: pending create + pending remove in the same bucket — sweep renumbers survivors', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final server = [a, b];
    final base = mkBase([(a, 'la'), (b, 'lb')]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('ln', 'url', 'New', url: 'https://new', parentId: 'bar', index: 0),
      lnA('la', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final touch = {
      'lb': TouchEntry(at: 1800, removed: true),
      'ln': TouchEntry(at: 1801),
    };
    final p = planSync(inp(server: server, local: local, base: base, touch: touch));
    // B deleted server-side (offline delete pushed)
    expect(p.serverOps.any((o) => o.op == 'delete' && o.id == 'b'), isTrue);
    // New created at slot 1
    final create = p.serverOps.where((o) => o.op == 'create').firstOrNull;
    expect(create?.position, 1);
    // A pushed to slot 2 (its bar index 1 + 1)
    expect(posOf(p, 'a'), 2);
    // B was deleted offline (node already gone): no local remove can exist
    expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lb'), isFalse);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('A5: two buckets swept in the same plan — independent slots, no cross-talk', () {
    final f = snA('f', 'folder', 'F', position: 1, updatedAt: 1000);
    final f1 = snA('f1', 'url', 'F1', url: 'https://f1', parentId: 'f', position: 1, updatedAt: 1000);
    final f2 = snA('f2', 'url', 'F2', url: 'https://f2', parentId: 'f', position: 2, updatedAt: 1000);
    final b1 = snA('b1', 'url', 'B1', url: 'https://b1', position: 2, updatedAt: 1000);
    final server = [f, f1, f2, b1];
    final base = mkBase([for (final s in server) (s, s.id)]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('f', 'folder', 'F', parentId: 'bar', index: 0),
      lnA('b1', 'url', 'B1', url: 'https://b1', parentId: 'bar', index: 1),
      lnA('f2', 'url', 'F2', url: 'https://f2', parentId: 'f', index: 0),
      lnA('f1', 'url', 'F1', url: 'https://f1', parentId: 'f', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'f2': TouchEntry(at: 1800)}));
    expect(posOf(p, 'f2'), 1);
    expect(posOf(p, 'f1'), 2);
    // bar rows untouched (no drift there)
    expect(posOf(p, 'b1'), isNull);
    expect(posOf(p, 'f'), isNull);
    expect(p.chromeOps.whereType<LocalMove>(), isEmpty);
  });

  test('A6a: future-dated touch still wins (server clamps at +300s)', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final server = [a, b];
    final base = mkBase([(a, 'a'), (b, 'b')]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    // now = 2000; touch 2600 (10 min ahead) — sweep must still emit
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 2600)}, now: 2000));
    expect(posOf(p, 'b'), 1);
    expect(posOf(p, 'a'), 2);
  });

  test('A6b: far-past touch with remotely-touched server rows loses', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1500);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1500);
    final server = [a, b];
    final base = mkBase([
      (snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000), 'a'),
      (snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000), 'b'),
    ]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    // both server rows moved since base (1500 > 1000); the drag is 1200 < 1500
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1200)}, now: 2000));
    expect(p.serverOps, isEmpty, reason: 'stale drag must not override remote edits');
    expect(p.chromeOps.whereType<LocalMove>(), isNotEmpty,
        reason: 'bar absorbs the server order');
  });

  test('A7: remote rename while the drag is in flight — sweep wins the slot, remote title survives', () {
    final a = snA('a', 'url', 'A-web', url: 'https://a', position: 1, updatedAt: 1500);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final server = [a, b];
    final base = mkBase([
      (snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000), 'a'),
      (b, 'b'),
    ]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1800)}));
    // drag (1800) beats the remote rename (1500): sweep proceeds
    expect(posOf(p, 'b'), 1);
    expect(posOf(p, 'a'), 2);
    // A's op must NOT carry a title (sweep never writes content)
    final aOp = p.serverOps.where((o) => o.op == 'update' && o.id == 'a').firstOrNull;
    expect(aOp?.title, isNull);
    // A's local title update comes from the content pass
    expect(
      p.chromeOps.whereType<LocalUpdate>().any((o) => o.localId == 'a' && o.title == 'A-web'),
      isTrue,
    );
  });

  test('A8: a removed journal neither vouches nor occupies a slot', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final c = snA('c', 'url', 'C', url: 'https://c', position: 3, updatedAt: 1000);
    final server = [a, b, c];
    final base = mkBase([for (final s in server) (s, s.id)]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'c': TouchEntry(at: 1800, removed: true)}));
    // C deleted; survivors [B, A] drift vs server rank [A, B] — but the only
    // journal is a removal, which must not reorder the server.
    expect(p.serverOps.where((o) => o.op == 'update' && o.position != null), isEmpty);
    expect(p.serverOps.any((o) => o.op == 'delete' && o.id == 'c'), isTrue);
  });

  test('A9: server child bound to a node in another parent — bucket abstains', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final f = snA('f', 'folder', 'F', position: 3, updatedAt: 1000);
    final server = [a, b, f];
    final base = mkBase([for (final s in server) (s, s.id)]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('f', 'folder', 'F', parentId: 'bar', index: 1),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 0),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'f', index: 0),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1800)}));
    // bar bucket must not sweep (membership incomplete)
    expect(posOf(p, 'a'), isNull);
    expect(posOf(p, 'f'), isNull);
    // the move pushes b's parentId instead
    final bOp = p.serverOps.where((o) => o.op == 'update' && o.id == 'b').firstOrNull;
    expect(bOp?.parentId, 'f');
  });

  test('A10: first pair (base null) must never sweep', () {
    final server = [
      snA('a', 'url', 'A', url: 'https://a', position: 1),
      snA('b', 'url', 'B', url: 'https://b', position: 2),
    ];
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: null, touch: {'b': TouchEntry(at: 1800)}));
    // first pair: nodes adopt; the bar order is NOT asserted onto the server
    expect(p.serverOps.where((o) => o.op == 'update' && o.position != null), isEmpty);
    expect(p.stats.adopted, 2);
  });

  test('A11: web reorder that landed mid-drag — sweep abstains for that bucket only', () {
    final f = snA('f', 'folder', 'F', position: 1, updatedAt: 1000);
    final fb = snA('fb', 'url', 'FB', url: 'https://fb', parentId: 'f', position: 1900, updatedAt: 1900);
    final fa = snA('fa', 'url', 'FA', url: 'https://fa', parentId: 'f', position: 1901, updatedAt: 1900);
    final ba = snA('ba', 'url', 'BA', url: 'https://ba', position: 1, updatedAt: 1000);
    final server = [f, fb, fa, ba];
    final base = mkBase([
      (snA('f', 'folder', 'F', position: 1, updatedAt: 1000), 'lf'),
      (snA('fa', 'url', 'FA', url: 'https://fa', parentId: 'f', position: 1, updatedAt: 1000), 'lfa'),
      (snA('fb', 'url', 'FB', url: 'https://fb', parentId: 'f', position: 2, updatedAt: 1000), 'lfb'),
      (snA('ba', 'url', 'BA', url: 'https://ba', position: 1, updatedAt: 1000), 'lba'),
    ]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('lf', 'folder', 'F', parentId: 'bar', index: 0),
      lnA('lba', 'url', 'BA', url: 'https://ba', parentId: 'bar', index: 1),
      lnA('lfa', 'url', 'FA', url: 'https://fa', parentId: 'lf', index: 0),
      lnA('lfb', 'url', 'FB', url: 'https://fb', parentId: 'lf', index: 1),
    ];
    final touch = {'lfa': TouchEntry(at: 1500), 'lba': TouchEntry(at: 1500)};
    final p = planSync(inp(server: server, local: local, base: base, touch: touch));
    // folder bucket: every row moved remotely (1900 > base 1000) and the
    // local touch (1500) is older → no folder sweep
    expect(posOf(p, 'fa'), isNull);
    expect(posOf(p, 'fb'), isNull);
    expect(posOf(p, 'ba'), isNull);
    // the bar converges to the web folder order [FB, FA]
    final moves = p.chromeOps.whereType<LocalMove>().toList();
    final faMove = moves.where((m) => m.localId == 'lfa').firstOrNull;
    final fbMove = moves.where((m) => m.localId == 'lfb').firstOrNull;
    expect(faMove?.index, 1);
    expect(fbMove?.index, 0);
  });

  test('A12: holder row is excluded from the bar sequence even when it sorts first', () {
    final holder = snA('md-others', 'folder', '其他书签', position: 0);
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final server = [holder, a, b];
    final base = mkBase([(holder, 'oroot'), (a, 'a'), (b, 'b')]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
      lnA('oroot', 'folder', '其他书签', isOtherRoot: true),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1800)}));
    // [B, A] drifted from rank [A=0, B=1] → swept to 1/2, NOT 2/3
    expect(posOf(p, 'b'), 1);
    expect(posOf(p, 'a'), 2);
    expect(posOf(p, 'md-others'), isNull, reason: 'the holder is never a sweep target');
  });

  test('A13: unchanged content but dragged — op carries the server-equal title (idempotent)', () {
    final a = snA('a', 'url', 'A', url: 'https://a', position: 1, updatedAt: 1000);
    final b = snA('b', 'url', 'B', url: 'https://b', position: 2, updatedAt: 1000);
    final server = [a, b];
    final base = mkBase([(a, 'a'), (b, 'b')]);
    final local = [
      lnA('bar', 'folder', '书签栏'),
      lnA('b', 'url', 'B', url: 'https://b', parentId: 'bar', index: 0),
      lnA('a', 'url', 'A', url: 'https://a', parentId: 'bar', index: 1),
    ];
    final p = planSync(inp(server: server, local: local, base: base, touch: {'b': TouchEntry(at: 1800)}));
    final bOp = p.serverOps.where((o) => o.op == 'update' && o.id == 'b').firstOrNull;
    expect(bOp?.title, 'B', reason: 'equal to server: harmless, advances the LWW clock');
    expect(bOp?.url, isNull, reason: 'URL never rides an equal-value write');
    expect(bOp?.position, 1);
    // and the plan is not churny: server = bar order after apply
    final serverNow = [
      snA('a', 'url', 'A', url: 'https://a', position: 2, updatedAt: 1800, revision: 30),
      snA('b', 'url', 'B', url: 'https://b', position: 1, updatedAt: 1800, revision: 31),
    ];
    final p2 = planSync(inp(
      server: serverNow,
      local: local,
      base: mkBase([for (final s in serverNow) (s, s.id)], 600),
    ));
    expect(p2.serverOps, isEmpty);
    expect(p2.chromeOps, isEmpty);
  });
}
