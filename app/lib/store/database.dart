import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'tables.dart';

part 'database.g.dart';

@DriftDatabase(tables: [Nodes, BaseEntries, Touches, MetaEntries])
class AppDatabase extends _$AppDatabase {
  AppDatabase(super.e);

  AppDatabase.open(String path) : super(_openAt(path));

  static QueryExecutor _openAt(String path) => NativeDatabase(File(path));

  static Future<String> defaultPath() async {
    final dir = await getApplicationSupportDirectory();
    return p.join(dir.path, 'markdeck.db');
  }

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(onCreate: (m) => m.createAll());

  // ---- meta helpers ----

  Future<String?> metaValue(String key) async {
    final row = await (select(metaEntries)..where((m) => m.k.equals(key))).getSingleOrNull();
    return row?.v;
  }

  Future<void> setMetaValue(String key, String value) => into(metaEntries)
      .insertOnConflictUpdate(MetaEntriesCompanion.insert(k: key, v: value));

  Future<int> metaInt(String key, {int fallback = 0}) async =>
      int.tryParse(await metaValue(key) ?? '') ?? fallback;

  Future<void> setMetaInt(String key, int value) => setMetaValue(key, '$value');

  // ---- node mapping (wire JSON <-> row) ----

  /// Wire shape (store.Bookmark JSON) -> row. Field names are locked by the
  /// wire contract test against server/internal/store/testdata golden files.
  static NodesCompanion nodeCompanionFromServerJson(Map<String, dynamic> j) =>
      NodesCompanion.insert(
        id: j['id'] as String,
        parentId: Value(((j['parentId'] as String?) ?? '')),
        type: j['type'] as String,
        title: (j['title'] as String?) ?? '',
        url: Value(j['url'] as String?),
        note: Value(((j['note'] as String?) ?? '')),
        favorite: Value(((j['favorite'] as bool?) ?? false)),
        archived: Value(((j['archived'] as bool?) ?? false)),
        position: Value(((j['position'] as num?) ?? 0).toDouble()),
        revision: Value(((j['revision'] as num?) ?? 0).toInt()),
        updatedAt: Value(((j['updatedAt'] as num?) ?? 0).toInt()),
        deviceId: Value(j['deviceId'] as String?),
        createdAt: Value(((j['createdAt'] as num?) ?? 0).toInt()),
        tags: Value(jsonEncode(((j['tags'] as List?) ?? []).map((e) => e.toString()).toList())),
      );

  /// Row -> wire JSON (store.Bookmark shape). Omissions match Go omitempty.
  Map<String, dynamic> nodeRowToServerJson(Node r) {
    final tags = jsonDecode(r.tags) as List;
    return {
        'id': r.id,
        'parentId': r.parentId,
        'type': r.type,
        'title': r.title,
        if (r.url != null && r.url!.isNotEmpty) 'url': r.url,
        if (r.note.isNotEmpty) 'note': r.note,
        'favorite': r.favorite,
        'archived': r.archived,
        'position': r.position,
        if (r.updatedAt > 0) 'updatedAt': r.updatedAt,
        if (r.deviceId != null && r.deviceId!.isNotEmpty) 'deviceId': r.deviceId,
        if (r.createdAt > 0) 'createdAt': r.createdAt,
        if (r.revision != 0) 'revision': r.revision,
        if (tags.isNotEmpty) 'tags': tags,
    };
  }

  // ---- library reads (offline browsing/search run on these) ----

  Stream<List<Node>> watchAllLive() =>
      (select(nodes)..where((n) => n.type.equals('folder') | n.type.equals('url'))).watch();

  Future<List<Node>> allNodes() => select(nodes).get();
}
