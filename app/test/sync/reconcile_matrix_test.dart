import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/sync/engine.dart';

// Port of extension/tests/reconcile-matrix.test.ts — convergence-matrix
// scenarios discovered by the sync-specific audit (2026-11-26). Each test
// encodes a full-lifecycle user story at the engine level.

int _rev = 100;

ServerNode sn(
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

LocalNode ln(
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

ServerOp? updOp(SyncPlan p, String id) =>
    p.serverOps.where((o) => o.op == 'update' && o.id == id).firstOrNull;

void main() {
  setUp(() => _rev = 100);

  group('matrix E1: snapshot-restore vs offline edit', () {
    test('a push that loses LWW must not re-push doomed updates forever', () {
      final baseRow =
          sn('x1', 'url', 'X0', url: 'https://x', updatedAt: 1000, revision: 5);
      final base = makeBase([(baseRow, 'c1')]);
      final restoredRow = sn('x1', 'url', 'X0',
          url: 'https://x', updatedAt: 5000, revision: 20);
      final local = [ln('c1', 'url', 'Offline', url: 'https://x')];
      final touch = {'c1': TouchEntry(at: 2000)};

      final p1 = planSync(input(server: [restoredRow], local: local, base: base, touch: touch));
      // touch (2000) OLDER than the restored row (5000): plan 1 must already
      // apply the server state, never emit a doomed push
      expect(p1.serverOps, isEmpty);
      expect(
        p1.chromeOps.whereType<LocalUpdate>().any((o) => o.serverId == 'x1' && o.title == 'X0'),
        isTrue,
      );

      // adapter applied: base advanced, touch cleared → next plan fixedpoint
      final advancedBase = makeBase([(restoredRow, 'c1')], 600);
      final p2 = planSync(input(server: [restoredRow], local: local, base: advancedBase));
      final doomed = p2.serverOps
          .where((o) => o.op == 'update' && o.id == 'x1' && o.updatedAt <= restoredRow.updatedAt);
      expect(doomed, isEmpty);
      expect(
        p2.chromeOps.whereType<LocalUpdate>().any((o) => o.serverId == 'x1' && o.title == 'X0'),
        isTrue,
      );
    });

    test('with the touch retained after a lost push, the next plan converges to server state', () {
      final restoredRow = sn('x1', 'url', 'X0',
          url: 'https://x', updatedAt: 5000, revision: 20);
      final local = [ln('c1', 'url', 'Offline', url: 'https://x')];
      final advancedBase = makeBase([(restoredRow, 'c1')], 600);
      final p = planSync(input(
        server: [restoredRow],
        local: local,
        base: advancedBase,
        touch: {'c1': TouchEntry(at: 2000)},
      ));
      expect(p.serverOps, isEmpty, reason: '2000 < 5000: no push');
      expect(p.chromeOps.whereType<LocalUpdate>().any((o) => o.title == 'X0'), isTrue);
    });
  });

  group('matrix B2: offline create inside a server-deleted folder', () {
    test('a minted row (revision 0) absent from the server is re-pushed, never removed', () {
      final fRow = sn('f1', 'folder', 'F', updatedAt: 900, revision: 3);
      final cMinted = ServerNode(
        id: 'minted-c',
        parentId: 'f1',
        type: 'url',
        title: 'C',
        url: 'https://precious',
        position: 1,
        revision: 0,
        updatedAt: 1700,
        deviceId: 'dev-1',
      );
      final base = makeBase([(fRow, 'lf'), (cMinted, 'lc')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf', 'folder', 'F', parentId: 'bar', index: 0),
        ln('lc', 'url', 'C', url: 'https://precious', parentId: 'lf', index: 0),
      ];
      final p = planSync(input(server: [], local: local, base: base));
      // C's content must be pushed (create — the server never confirmed it)
      final pushed = p.serverOps.where((o) => o.op == 'create' && o.id == 'minted-c').firstOrNull;
      expect(pushed, isNotNull);
      // parent F is gone server-side: the push must NOT reference it
      expect(pushed!.parentId, '');
      // F (confirmed server row, now deleted) is removed locally
      expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.serverId == 'f1'), isTrue);
      // C's LOCAL node must not be removed
      expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lc'), isFalse);
    });

    test('removing a server-deleted folder does NOT cascade into unconfirmed minted children', () {
      final fRow = sn('f1', 'folder', 'F', updatedAt: 900, revision: 3);
      final cMinted = ServerNode(
        id: 'minted-c',
        parentId: 'f1',
        type: 'url',
        title: 'C',
        url: 'https://precious',
        position: 1,
        revision: 0,
        updatedAt: 1700,
        deviceId: 'dev-1',
      );
      final base = makeBase([(fRow, 'lf'), (cMinted, 'lc')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf', 'folder', 'F', parentId: 'bar', index: 0),
        ln('lc', 'url', 'C', url: 'https://precious', parentId: 'lf', index: 0),
      ];
      final p = planSync(input(server: [], local: local, base: base));
      expect(p.serverOps.any((o) => o.op == 'create' && o.id == 'minted-c'), isTrue);
      expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lf'), isTrue);
      expect(p.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lc'), isFalse);
    });

    test('deep minted chain re-roots to the nearest live bound ancestor', () {
      final f1Row = sn('f1', 'folder', 'F1', updatedAt: 900, revision: 3);
      final f2Minted = ServerNode(
        id: 'minted-f2',
        parentId: 'f1',
        type: 'folder',
        title: 'F2',
        position: 1,
        revision: 0,
        updatedAt: 1700,
        deviceId: 'dev-1',
      );
      final cMinted = ServerNode(
        id: 'minted-c',
        parentId: 'minted-f2',
        type: 'url',
        title: 'C',
        url: 'https://deep',
        position: 1,
        revision: 0,
        updatedAt: 1700,
        deviceId: 'dev-1',
      );
      final base = makeBase([(f1Row, 'lf1'), (f2Minted, 'lf2'), (cMinted, 'lc')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf1', 'folder', 'F1', parentId: 'bar', index: 0),
        ln('lf2', 'folder', 'F2', parentId: 'lf1', index: 0),
        ln('lc', 'url', 'C', url: 'https://deep', parentId: 'lf2', index: 0),
      ];
      final p = planSync(input(server: [f1Row], local: local, base: base));
      final pushedC =
          p.serverOps.where((o) => o.op == 'create' && o.id == 'minted-c').firstOrNull;
      expect(pushedC, isNotNull);
      expect(pushedC!.parentId, 'f1', reason: 're-rooted under the surviving F1');
      final pushedF2 =
          p.serverOps.where((o) => o.op == 'create' && o.id == 'minted-f2').firstOrNull;
      expect(pushedF2, isNotNull);
      expect(pushedF2!.parentId, 'f1');
    });
  });

  group('matrix B1: dual-device same-row edits (self-heal lock)', () {
    test('loser content with no touch and unchanged server converges to the server copy', () {
      final baseRow =
          sn('x1', 'url', 'A-edit', url: 'https://x', updatedAt: 1200, revision: 9);
      final base = makeBase([(baseRow, 'c1')]);
      final local = [ln('c1', 'url', 'B-edit', url: 'https://x')];
      final p = planSync(input(server: [baseRow], local: local, base: base));
      expect(p.serverOps, isEmpty, reason: 'never re-push a touchless loser');
      expect(p.chromeOps.whereType<LocalUpdate>().any((o) => o.title == 'A-edit'), isTrue);
    });
  });

  group('matrix round 2: purge terminality + forceResync journal (N2/N9)', () {
    test('N2: offline edit under a purged folder converges — no undelete loop', () {
      final fRow = sn('f1', 'folder', 'F', updatedAt: 900, revision: 3);
      final cRow = sn('c1', 'url', 'C',
          url: 'https://c/x', parentId: 'f1', updatedAt: 900, revision: 4);
      final base = makeBase([(fRow, 'lf'), (cRow, 'lc')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf', 'folder', 'F', parentId: 'bar', index: 0),
        ln('lc', 'url', 'C-renamed', url: 'https://c/x', parentId: 'lf', index: 0),
      ];
      // round 1: edit timestamp NEWER than purge → undelete push attempted
      final p1 = planSync(input(
        server: [],
        local: local,
        base: base,
        touch: {'lc': TouchEntry(at: 2000)},
      ));
      expect(
        p1.serverOps.any((o) => o.op == 'update' && o.id == 'c1' && o.undelete),
        isTrue,
      );
      // server REJECTED it (purged); adapter advanced base; touch SURVIVES.
      // Round 2: the edit timestamp is now ≤ the purge timestamp → no more
      // undelete; deletion wins with a local remove.
      final advancedBase = makeBase([
        (sn('f1', 'folder', 'F', updatedAt: 2500, revision: 9), 'lf'),
        (sn('c1', 'url', 'C', url: 'https://c/x', parentId: 'f1', updatedAt: 2500, revision: 10), 'lc'),
      ], 600);
      final p2 = planSync(input(
        server: [],
        local: local,
        base: advancedBase,
        touch: {'lc': TouchEntry(at: 2000)},
      ));
      expect(p2.serverOps.any((o) => o.op == 'update' && o.undelete), isFalse);
      expect(p2.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lc'), isTrue);
      expect(p2.chromeOps.whereType<LocalRemove>().any((o) => o.localId == 'lf'), isTrue);
    });

    test('N9: forceResync (base wiped, touch kept) preserves the pending offline rename', () {
      final baseRow =
          sn('x1', 'url', 'Original', url: 'https://keep/x', updatedAt: 900, revision: 5);
      final local = [ln('c1', 'url', 'Renamed', url: 'https://keep/x')];
      final p = planSync(input(
        server: [baseRow],
        local: local,
        base: null,
        touch: {'c1': TouchEntry(at: 2000)},
      ));
      expect(
        p.serverOps.any((o) => o.op == 'update' && o.id == 'x1' && o.title == 'Renamed'),
        isTrue,
      );
      expect(
        p.chromeOps.whereType<LocalUpdate>().any((o) => o.title == 'Original'),
        isFalse,
      );
    });
  });

  group('matrix round 3: swap-reparent (P7)', () {
    test('server swaps two folders parent/child in one batch — BOTH moves planned, fixedpoint after', () {
      final f1 = sn('f1', 'folder', 'F1', position: 1, updatedAt: 900, revision: 3);
      final f2 = sn('f2', 'folder', 'F2', parentId: 'f1', position: 1, updatedAt: 900, revision: 4);
      final base = makeBase([(f1, 'lf1'), (f2, 'lf2')]);
      final serverNow = [
        sn('f1', 'folder', 'F1', parentId: 'f2', position: 1, updatedAt: 1800, revision: 8),
        sn('f2', 'folder', 'F2', position: 2, updatedAt: 1800, revision: 9),
      ];
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf1', 'folder', 'F1', parentId: 'bar', index: 0),
        ln('lf2', 'folder', 'F2', parentId: 'lf1', index: 0),
      ];
      final p = planSync(input(server: serverNow, local: local, base: base));
      expect(
        p.chromeOps.whereType<LocalMove>().any((o) => o.serverId == 'f1' && o.parentServerId == 'f2'),
        isTrue,
      );
      expect(
        p.chromeOps.whereType<LocalMove>().any((o) => o.serverId == 'f2' && o.parentServerId == ''),
        isTrue,
      );
      // after both moves execute, the next plan is a fixedpoint
      final localAfter = [
        local[0],
        ln('lf2', 'folder', 'F2', parentId: 'bar', index: 0),
        ln('lf1', 'folder', 'F1', parentId: 'lf2', index: 0),
      ];
      final p2 = planSync(input(
        server: serverNow,
        local: localAfter,
        base: makeBase([(serverNow[0], 'lf1'), (serverNow[1], 'lf2')], 600),
      ));
      expect(p2.chromeOps, isEmpty);
    });

    test('root-bucket parent vs folder server parent is a MISMATCH, not an abstention', () {
      final f1 = sn('f1', 'folder', 'F1', position: 1, updatedAt: 900, revision: 3);
      final f2 = sn('f2', 'folder', 'F2', parentId: 'f1', position: 1, updatedAt: 900, revision: 4);
      final base = makeBase([(f1, 'lf1'), (f2, 'lf2')]);
      final local = [
        ln('bar', 'folder', '书签栏'),
        ln('lf1', 'folder', 'F1', parentId: 'bar', index: 0),
        ln('lf2', 'folder', 'F2', parentId: 'bar', index: 1),
      ];
      final p = planSync(input(
        server: [
          sn('f2', 'folder', 'F2', parentId: 'f1', updatedAt: 1800, revision: 8),
          f1,
        ],
        local: local,
        base: base,
      ));
      expect(p.chromeOps.whereType<LocalMove>().any((o) => o.serverId == 'f2'), isTrue);
    });
  });
}
