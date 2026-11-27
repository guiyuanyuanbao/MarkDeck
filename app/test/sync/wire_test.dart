import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:markdeck/sync/engine.dart';

/// Cross-repo wire-contract test: the app hand-mirrors the server's
/// store.BatchOp (ServerOp) and store.Bookmark (ServerNode) JSON shapes.
/// Golden fixtures live with the Go suite (server/internal/store/testdata/)
/// — Go, TS and Dart all assert against the same bytes.
void main() {
  // flutter test runs from app/; goldens are two dirs up
  final goldenDir = Directory('../server/internal/store/testdata');
  test('golden dir exists (repo layout unchanged)', () {
    expect(goldenDir.existsSync(), isTrue,
        reason: 'run from app/; goldens at ../server/internal/store/testdata');
  });

  group('wire contract: server BatchOp ↔ app ServerOp', () {
    late List<Map<String, dynamic>> raw;
    setUpAll(() {
      raw = (jsonDecode(File('${goldenDir.path}/batchops.golden.json').readAsStringSync())
              as List)
          .cast<Map<String, dynamic>>();
    });

    test('three ops: create / update / delete', () {
      expect(raw, hasLength(3));
      expect(raw.map((o) => o['op']).toList(), ['create', 'update', 'delete']);
    });

    test('create op carries every field the server ApplyBatch reads', () {
      const keys = [
        'id', 'parentId', 'type', 'title', 'url', 'position',
        'updatedAt', 'deviceId', 'observedRevision',
      ];
      for (final k in keys) {
        expect(raw[0].containsKey(k), isTrue, reason: 'create op missing $k');
      }
    });

    test('update op carries merge fields; delete op is bare', () {
      const keys = ['id', 'title', 'tags', 'undelete', 'updatedAt', 'deviceId', 'observedRevision'];
      for (final k in keys) {
        expect(raw[1].containsKey(k), isTrue, reason: 'update op missing $k');
      }
      expect(raw[2].containsKey('parentId'), isFalse);
      expect(raw[2].containsKey('title'), isFalse);
    });

    test('decode through the real ServerOp round-trip keeps protocol fields', () {
      final ops = raw.map((o) {
        switch (o['op'] as String) {
          case 'create':
            return ServerOp.create(
              id: o['id'] as String,
              parentId: o['parentId'] as String,
              type: o['type'] as String,
              title: o['title'] as String,
              url: o['url'] as String?,
              position: (o['position'] as num).toDouble(),
              updatedAt: (o['updatedAt'] as num).toInt(),
              tags: (o['tags'] as List?)?.cast<String>(),
            );
          case 'update':
            return ServerOp.update(
              id: o['id'] as String,
              title: o['title'] as String?,
              tags: (o['tags'] as List?)?.cast<String>(),
              undelete: o['undelete'] as bool? ?? false,
              updatedAt: (o['updatedAt'] as num).toInt(),
              observedRevision: (o['observedRevision'] as num).toInt(),
            );
          default:
            return ServerOp.delete(
              id: o['id'] as String,
              updatedAt: (o['updatedAt'] as num).toInt(),
            );
        }
      }).toList();

      // decoded values the engine relies on
      expect(ops[0].position, 2.5);
      expect(ops[1].undelete, isTrue);
      expect(ops[2].op, 'delete');
    });

    test('engine-produced create op serializes with the same wire keys', () {
      final op = ServerOp.create(
        id: 'x1',
        parentId: 'p',
        type: 'url',
        title: 'T',
        url: 'https://x',
        position: 2.5,
        updatedAt: 1700000000,
        tags: ['tag1', 'tag2'],
      );
      final j = op.toJson('dev-1');
      // keys must be exactly the golden shape (field names = protocol)
      for (final k in ['op', 'id', 'parentId', 'type', 'title', 'url', 'position', 'tags', 'updatedAt', 'deviceId']) {
        expect(j.containsKey(k), isTrue, reason: 'serialized create missing $k');
      }
      expect(j['position'], 2.5);
      expect(j['deviceId'], 'dev-1');
    });
  });

  group('wire contract: server Bookmark ↔ engine ServerNode', () {
    late List<Map<String, dynamic>> rows;
    setUpAll(() {
      rows = (jsonDecode(File('${goldenDir.path}/bookmark.golden.json').readAsStringSync())
              as List)
          .cast<Map<String, dynamic>>();
    });

    test('tree rows carry every field the engine reads', () {
      const keys = ['id', 'parentId', 'type', 'title', 'position', 'revision', 'updatedAt'];
      for (final k in keys) {
        expect(rows[0].containsKey(k), isTrue, reason: 'tree row missing $k');
      }
      expect(rows[0]['deletedAt'], 1700000100);
    });

    test('ServerNode.fromJson decodes golden rows', () {
      final n = ServerNode.fromJson(rows[0]);
      expect(n.id, 'row-1');
      expect(n.parentId, 'root');
      expect(n.type, 'url');
      expect(n.title, 'Example');
      expect(n.url, 'https://example.com');
      expect(n.position, 1.5);
      expect(n.revision, 12);
      expect(n.updatedAt, 1700000000);
      expect(n.deviceId, 'dev-1');
    });

    test('round-trip through toJson preserves engine-relevant fields', () {
      final n = ServerNode.fromJson(rows[0]);
      final j = n.toJson();
      expect(j['id'], 'row-1');
      expect(j['parentId'], 'root');
      expect(j['type'], 'url');
      expect(j['position'], 1.5);
      expect(j['revision'], 12);
      expect(j['updatedAt'], 1700000000);
    });
  });
}
