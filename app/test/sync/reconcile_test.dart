import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/sync/engine.dart';

// Port of extension/tests/reconcile.test.ts — the engine's contract is
// CONVERGENCE: reconciling the same trees twice must plan zero ops the
// second time, and every diff scenario must terminate in a consistent
// state on both ends. Tests encode that property directly.

// ---- builders ----

int _rev = 100;
ServerNode sn(
  String id,
  String type,
  String title, {
  String? parentId,
  String? url,
  double position = 1,
  int? revision,
  int updatedAt = 1000,
  String deviceId = 'srv',
}) {
  _rev++;
  return ServerNode(
    id: id,
    parentId: parentId ?? '',
    type: type,
    title: title,
    url: url,
    position: position,
    revision: revision ?? _rev,
    updatedAt: updatedAt,
    deviceId: deviceId,
  );
}

LocalNode ln(
  String id,
  String type,
  String title, {
  String parentId = '',
  String? url,
  int index = 0,
  int? dateAdded,
  bool isOtherRoot = false,
}) =>
    LocalNode(
      id: id,
      parentId: parentId,
      type: type,
      title: title,
      url: url,
      index: index,
      dateAdded: dateAdded,
      isOtherRoot: isOtherRoot,
    );

Base makeBase(
  List<(ServerNode, String?)> entries, {
  int head = 500,
  String othersId = 'md-others',
}) {
  final e = <String, BaseEntry>{};
  for (final (server, localId) in entries) {
    e[server.id] = BaseEntry(server: server, localId: localId);
  }
  return Base(head: head, othersId: othersId, entries: e);
}

PlanInput input({
  List<ServerNode>? server,
  List<LocalNode>? local,
  Base? base,
  TouchJournal? touch,
  String deviceId = 'dev-1',
  int now = 2000,
  String othersId = 'md-others',
}) =>
    PlanInput(
      server: server ?? [],
      local: local ?? [],
      base: base,
      touch: touch ?? {},
      deviceId: deviceId,
      now: now,
      othersId: othersId,
    );

// ---- convergence property ----

void main() {
  setUp(() => _rev = 100);

  group('convergence property', () {
    test('reconciling the same trees twice plans zero ops the second time', () {
      final server = [
        sn('f1', 'folder', 'Tech', position: 1),
        sn('b1', 'url', 'Go', url: 'https://go.dev', parentId: 'f1', position: 1),
        sn('b2', 'url', 'Rust', url: 'https://rust.lang', position: 2),
        sn('md-others', 'folder', '其他书签', position: 9999),
      ];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('c1', 'folder', 'Tech', parentId: 'bar', index: 0),
        ln('c2', 'url', 'Go', url: 'https://go.dev', parentId: 'c1', index: 0),
        ln('c3', 'url', 'Rust', url: 'https://rust.lang', parentId: 'bar', index: 1),
        ln('other-root', 'folder', '其他书签', isOtherRoot: true),
      ];
      // first plan with no base: full import
      final p1 = planSync(input(server: server, local: local));
      expect(p1.serverOps, isEmpty, reason: 'everything is already on the server');
      // the plan must bind every server row to a local node
      expect(p1.newBaseEntries.keys.length, server.length);

      // simulate the adapter executing local ops, building the bound base
      final base = makeBase(
        [for (final e in p1.newBaseEntries.values) (e.server, e.localId)],
        head: 500,
      );
      // second plan, same trees + fresh base: ZERO ops (fixedpoint)
      final p2 = planSync(input(server: server, local: local, base: base));
      expect(p2.chromeOps, isEmpty);
      expect(p2.serverOps, isEmpty);
    });

    test('failed reconcile (base not advanced) re-plans identical ops', () {
      final server = [sn('b1', 'url', 'Go', url: 'https://go.dev')];
      final local = [ln('bar', 'folder', '书签栏')];
      final p1 = planSync(input(server: server, local: local));
      final p2 = planSync(input(server: server, local: local));
      expect(p2.chromeOps.length, p1.chromeOps.length);
      expect(p2.chromeOps.first, isA<LocalCreate>());
      expect((p2.chromeOps.first as LocalCreate).serverId, 'b1');
    });
  });

  // ---- server → local ----

  group('server → local', () {
    test('new server rows plan local creates, parent-first', () {
      final server = [
        sn('md-others', 'folder', '其他书签', position: 9999),
        sn('f1', 'folder', 'A', position: 1),
        sn('b1', 'url', 'X', url: 'https://x', parentId: 'f1', position: 1),
      ];
      final p = planSync(input(server: server, local: [ln('bar', 'folder', '书签栏')]));
      final creates = p.chromeOps.whereType<LocalCreate>().toList();
      final fIdx = creates.indexWhere((c) => c.serverId == 'f1');
      final bIdx = creates.indexWhere((c) => c.serverId == 'b1');
      expect(fIdx, greaterThanOrEqualTo(0));
      expect(bIdx, greaterThan(fIdx), reason: 'parent before child');
    });

    test('title change on the server plans a local update', () {
      final old = sn('b1', 'url', 'Old', url: 'https://x');
      final base = makeBase([(old, 'c1')]);
      final newer = sn('b1', 'url', 'New',
          url: 'https://x', updatedAt: 1500, revision: old.revision + 1);
      final local = [ln('c1', 'url', 'Old', url: 'https://x')];
      final p = planSync(input(server: [newer], local: local, base: base));
      expect(p.chromeOps, hasLength(1));
      final u = p.chromeOps.first as LocalUpdate;
      expect(u.localId, 'c1');
      expect(u.title, 'New');
    });

    test('server deletion plans a local remove (base entry absent from tree)', () {
      final b1 = sn('b1', 'url', 'Go', url: 'https://go.dev');
      final base = makeBase([(b1, 'c1')]);
      final local = [ln('c1', 'url', 'Go', url: 'https://go.dev')];
      final p = planSync(input(server: [], local: local, base: base));
      expect(p.chromeOps, hasLength(1));
      final r = p.chromeOps.first as LocalRemove;
      expect(r.serverId, 'b1');
      expect(r.localId, 'c1');
    });

    test('slash-divergent URL is the same bookmark (no duplicate creates)', () {
      final server = [sn('b1', 'url', 'Site', url: 'https://x.com/')];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('c1', 'url', 'Site', url: 'https://x.com', parentId: 'bar', index: 0),
      ];
      final p = planSync(input(server: server, local: local));
      expect(p.chromeOps.whereType<LocalCreate>(), isEmpty, reason: 'adopted, not created');
      expect(p.stats.adopted, 1);
      expect(p.newBaseEntries['b1']!.localId, 'c1');
    });

    test('server-only folder rename cascades without touching children bindings', () {
      final f1 = sn('f1', 'folder', 'A', position: 1);
      final b1 = sn('b1', 'url', 'X', url: 'https://x', parentId: 'f1', position: 1);
      final base = makeBase([(f1, 'c1'), (b1, 'c2')]);
      final newer = sn('f1', 'folder', 'B', updatedAt: 1500, revision: f1.revision + 1);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('c1', 'folder', 'A', parentId: 'bar', index: 0),
        ln('c2', 'url', 'X', url: 'https://x', parentId: 'c1', index: 0),
      ];
      final p = planSync(input(server: [newer, b1], local: local, base: base));
      expect(p.chromeOps, hasLength(1));
      final u = p.chromeOps.first as LocalUpdate;
      expect(u.localId, 'c1');
      expect(u.title, 'B');
      // child binding survives: newBase keeps b1 → c2
      expect(p.newBaseEntries['b1']!.localId, 'c2');
    });
  });

  // ---- local → server ----

  group('local → server', () {
    test('new local bookmarks plan server creates with stable minted ids', () {
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('c1', 'url', 'New', url: 'https://new.dev', parentId: 'bar', index: 0),
      ];
      final p = planSync(input(local: local, touch: {'c1': TouchEntry(at: 1900)}));
      expect(p.serverOps, hasLength(1));
      final op = p.serverOps.first;
      expect(op.title, 'New');
      expect(op.url, 'https://new.dev');
      expect(op.updatedAt, 1900);
      final minted = op.id;
      // re-plan: identical minted id (stability across re-plans)
      final p2 = planSync(input(local: local, touch: {'c1': TouchEntry(at: 1900)}));
      expect(p2.serverOps.first.id, minted);
    });

    test('local title edit pushes an update carrying the touch timestamp', () {
      final b1 = sn('b1', 'url', 'Old', url: 'https://x');
      final base = makeBase([(b1, 'c1')]);
      final local = [ln('c1', 'url', 'Edited locally', url: 'https://x')];
      final p = planSync(input(
        server: [b1],
        local: local,
        base: base,
        touch: {'c1': TouchEntry(at: 1800)},
      ));
      expect(p.serverOps, hasLength(1));
      final op = p.serverOps.first;
      expect(op.op, 'update');
      expect(op.id, 'b1');
      expect(op.title, 'Edited locally');
      expect(op.updatedAt, 1800);
      expect(op.observedRevision, b1.revision);
      expect(p.chromeOps, isEmpty, reason: 'server unchanged: nothing applies locally');
    });

    test('local deletion pushes a server delete', () {
      final b1 = sn('b1', 'url', 'Go', url: 'https://go.dev');
      final base = makeBase([(b1, 'c1')]);
      final p = planSync(input(
        server: [b1],
        local: [],
        base: base,
        touch: {'c1': TouchEntry(at: 1900, removed: true)},
      ));
      expect(p.serverOps, hasLength(1));
      expect(p.serverOps.first.op, 'delete');
      expect(p.serverOps.first.id, 'b1');
    });
  });

  // ---- conflicts (both sides changed) ----

  group('conflicts', () {
    test('local edit newer than server: local wins, server gets the push', () {
      final b1 = sn('b1', 'url', 'Base', url: 'https://x', updatedAt: 1000);
      final base = makeBase([(b1, 'c1')]);
      final serverNow =
          sn('b1', 'url', 'Server edit', url: 'https://x', updatedAt: 1500, revision: b1.revision + 1);
      final local = [ln('c1', 'url', 'Local edit', url: 'https://x')];
      final p = planSync(input(
        server: [serverNow],
        local: local,
        base: base,
        touch: {'c1': TouchEntry(at: 1800)},
      ));
      expect(p.serverOps, hasLength(1));
      expect(p.serverOps.first.title, 'Local edit');
      expect(p.serverOps.first.updatedAt, 1800);
      expect(p.chromeOps, isEmpty);
    });

    test('server edit newer than local: server wins, local gets the update', () {
      final b1 = sn('b1', 'url', 'Base', url: 'https://x', updatedAt: 1000);
      final base = makeBase([(b1, 'c1')]);
      final serverNow =
          sn('b1', 'url', 'Server edit', url: 'https://x', updatedAt: 1900, revision: b1.revision + 1);
      final local = [ln('c1', 'url', 'Local edit', url: 'https://x')];
      final p = planSync(input(
        server: [serverNow],
        local: local,
        base: base,
        touch: {'c1': TouchEntry(at: 1500)},
      ));
      expect(p.chromeOps, hasLength(1));
      expect((p.chromeOps.first as LocalUpdate).title, 'Server edit');
      expect(p.serverOps, isEmpty);
    });
  });

  // ---- offline replay ----

  group('offline edits replay without a queue', () {
    test('edits made while offline re-plan identically until acked', () {
      final b1 = sn('b1', 'url', 'Base', url: 'https://x');
      final base = makeBase([(b1, 'c1')]);
      final local = [ln('c1', 'url', 'Offline rename', url: 'https://x')];
      final touch = {'c1': TouchEntry(at: 1800)};
      final p1 = planSync(input(server: [b1], local: local, base: base, touch: touch));
      final p2 = planSync(input(server: [b1], local: local, base: base, touch: touch));
      expect(p2.serverOps.length, p1.serverOps.length);
      expect(p2.serverOps.first.id, p1.serverOps.first.id);
      expect(p2.serverOps.first.title, p1.serverOps.first.title);
      expect(p2.serverOps.first.updatedAt, p1.serverOps.first.updatedAt);
    });

    test('locally created folders + children arrive as one ordered batch', () {
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('f1', 'folder', 'Deep', parentId: 'bar', index: 0),
        ln('f2', 'folder', 'Deeper', parentId: 'f1', index: 0),
        ln('c1', 'url', 'Leaf', url: 'https://leaf', parentId: 'f2', index: 0),
      ];
      final touch = {
        'f1': TouchEntry(at: 1900),
        'f2': TouchEntry(at: 1900),
        'c1': TouchEntry(at: 1900),
      };
      final p = planSync(input(local: local, touch: touch));
      expect(p.serverOps, hasLength(3));
      // the leaf's parentId must resolve to its folder's minted id
      final leaf = p.serverOps.firstWhere((o) => o.title == 'Leaf');
      final deeper = p.serverOps.firstWhere((o) => o.title == 'Deeper');
      expect(leaf.parentId, deeper.id);
    });
  });

  // ---- 其他书签 structural binding ----

  group('other-bookmarks structural binding', () {
    test('local other-root binds to the canonical holder, content flows both ways', () {
      final server = [
        sn('md-others', 'folder', '其他书签', position: 9999),
        sn('ob1', 'url', 'From server', url: 'https://srv', parentId: 'md-others', position: 1),
      ];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('other-root', 'folder', '其他书签', isOtherRoot: true),
        ln('oc1', 'url', 'From local', url: 'https://loc', parentId: 'other-root', index: 0),
      ];
      final touch = {'oc1': TouchEntry(at: 1900)};
      final p = planSync(input(server: server, local: local, touch: touch));
      // server row applies into the other-root bucket
      expect(p.chromeOps.whereType<LocalCreate>().any((o) => o.serverId == 'ob1'), isTrue);
      // local row pushes under the canonical holder id
      expect(
        p.serverOps.any((o) => o.title == 'From local' && o.parentId == 'md-others'),
        isTrue,
      );
      // the holder row itself never pushes (structural, not data)
      expect(p.serverOps.any((o) => o.title == '其他书签'), isFalse);
    });

    test('3-root layout: mobile bookmarks are ignored entirely', () {
      final server = [sn('md-others', 'folder', '其他书签', position: 9999)];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('other-root', 'folder', '其他书签', isOtherRoot: true),
        ln('mobile-root', 'folder', 'Mobile bookmarks'),
        ln('m1', 'url', 'Mobile-only', url: 'https://m', parentId: 'mobile-root', index: 0),
      ];
      final p = planSync(input(server: server, local: local));
      // mobile content never syncs (out of scope), never pushes
      expect(p.serverOps.any((o) => o.title == 'Mobile-only'), isFalse);
    });
  });

  // ---- adoption / graveyard scenarios ----

  group('adoption', () {
    test('unbound same-URL local node adopts instead of duplicating across resync', () {
      final server = [
        sn('f1', 'folder', 'F', position: 1),
        sn('b1', 'url', 'Same', url: 'https://same', parentId: 'f1', position: 1),
      ];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('cf', 'folder', 'F', parentId: 'bar', index: 0),
        ln('cc', 'url', 'Same', url: 'https://same', parentId: 'cf', index: 0),
      ];
      final p = planSync(input(server: server, local: local));
      final urlCreates =
          p.chromeOps.whereType<LocalCreate>().where((o) => o.type == 'url').toList();
      expect(urlCreates, isEmpty, reason: 'adopted');
      expect(p.stats.adopted, 2, reason: 'folder shell + url both adopt');
      expect(p.newBaseEntries['b1']!.localId, 'cc');
      expect(p.newBaseEntries['f1']!.localId, 'cf');
    });

    test('live row + unbound local node with same URL adopt (tombstones invisible)', () {
      final live = sn('live1', 'url', 'Page', url: 'https://page', updatedAt: 2000);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('c1', 'url', 'Page', url: 'https://page', parentId: 'bar', index: 0),
      ];
      final p = planSync(input(server: [live], local: local));
      expect(p.chromeOps.whereType<LocalCreate>(), isEmpty);
      expect(p.stats.adopted, 1);
    });

    test('server row vanished but unbound node with same URL exists: rebind, not delete', () {
      final b1 = sn('b1', 'url', 'Page', url: 'https://page');
      final base = makeBase([(b1, 'old-local-node')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('new-node', 'url', 'Page', url: 'https://page', parentId: 'bar', index: 0),
      ];
      final p = planSync(input(
        server: [],
        local: local,
        base: base,
        touch: {'old-local-node': TouchEntry(at: 1900, removed: true)},
      ));
      expect(
        p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'new-node'),
        isFalse,
      );
      expect(p.newBaseEntries['b1']!.localId, 'new-node');
    });
  });

  // ---- resync from scratch ----

  group('force resync (wiped base) converges without duplicates', () {
    test('wiping base and re-planning binds onto the existing tree', () {
      final server = [
        sn('f1', 'folder', 'Work', position: 1),
        sn('b1', 'url', 'Go', url: 'https://go.dev', parentId: 'f1', position: 1),
        sn('md-others', 'folder', '其他书签', position: 9999),
      ];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('cf', 'folder', 'Work', parentId: 'bar', index: 0),
        ln('cc', 'url', 'Go', url: 'https://go.dev', parentId: 'cf', index: 0),
        ln('other-root', 'folder', '其他书签', isOtherRoot: true),
      ];
      // base wiped (force resync): full adopt pass
      final p = planSync(input(server: server, local: local, base: null));
      expect(
        p.chromeOps.whereType<LocalCreate>().where((o) => o.type == 'url'),
        isEmpty,
      );
      expect(p.newBaseEntries['b1']!.localId, 'cc');
      expect(p.newBaseEntries['f1']!.localId, 'cf');
      // second run after base advance: fixedpoint
      final base = makeBase(
        [for (final e in p.newBaseEntries.values) (e.server, e.localId)],
      );
      final p2 = planSync(input(server: server, local: local, base: base));
      expect(p2.chromeOps, isEmpty);
      expect(p2.serverOps, isEmpty);
    });
  });

  // ---- helpers ----

  group('helpers', () {
    test('normBookmarkUrl strips trailing slashes and lowercases', () {
      expect(normBookmarkUrl('https://X.com/'), 'https://x.com');
      expect(normBookmarkUrl('https://x.com'), 'https://x.com');
      expect(normBookmarkUrl(''), '');
    });

    test('mintStableId is deterministic and UUID-shaped', () {
      final n = ln('x', 'url', 'T', url: 'https://t', parentId: 'bar', index: 2);
      final a = mintStableId(n);
      final b = mintStableId(n);
      expect(a, b);
      expect(
        RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$')
            .hasMatch(a),
        isTrue,
      );
      final m = mintStableId(LocalNode(
        id: n.id,
        parentId: n.parentId,
        type: n.type,
        title: 'Different',
        url: n.url,
        index: n.index,
      ));
      expect(m, isNot(a));
    });
  });
}
