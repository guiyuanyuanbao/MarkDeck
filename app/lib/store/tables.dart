import 'package:drift/drift.dart';

// Local mirror of the server bookmark tree. Local ids ARE server ids (the
// server accepts client-chosen ids), so base localId == row id always —
// no id-mapping table exists anywhere (the v0.1.0 lesson).

// A live or trashed node mirroring server Bookmark (store/model.go).
class Nodes extends Table {
  TextColumn get id => text()(); // = server UUID
  TextColumn get parentId => text().withDefault(const Constant(''))();
  TextColumn get type => text()(); // 'folder' | 'url'
  TextColumn get title => text()();
  TextColumn get url => text().nullable()();
  TextColumn get note => text().withDefault(const Constant(''))();
  BoolColumn get favorite => boolean().withDefault(const Constant(false))();
  BoolColumn get archived => boolean().withDefault(const Constant(false))();
  RealColumn get position => real().withDefault(const Constant(0.0))();
  IntColumn get revision => integer().withDefault(const Constant(0))();
  IntColumn get updatedAt => integer().withDefault(const Constant(0))(); // unix s
  TextColumn get deviceId => text().nullable()();
  IntColumn get createdAt => integer().withDefault(const Constant(0))(); // unix s
  TextColumn get tags => text().withDefault(const Constant('[]'))(); // JSON array

  @override
  Set<Column> get primaryKey => {id};
}

// Base snapshot entry: what the server row looked like at the last
// successful reconcile. The binding is implicit: localId == serverId.
class BaseEntries extends Table {
  TextColumn get serverId => text()(); // PK = server id
  TextColumn get serverJson => text()(); // full ServerNode wire JSON
  IntColumn get appliedAt => integer().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {serverId};
}

// Touch journal: local edits since the last reconcile (unix-second clocks).
// NOT an op queue — the engine re-derives ops by diffing local vs base.
class Touches extends Table {
  TextColumn get id => text()(); // local id (= server id)
  IntColumn get at => integer().withDefault(const Constant(0))();
  BoolColumn get removed => boolean().withDefault(const Constant(false))();
  TextColumn get title => text().nullable()();
  TextColumn get url => text().nullable()();
  TextColumn get tags => text().nullable()(); // JSON array, quick-save tags
  BoolColumn get reordered => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

// Key-value meta: head, othersId, serverUrl, deviceId, status, schemaVersion.
class MetaEntries extends Table {
  TextColumn get k => text()();
  TextColumn get v => text()();

  @override
  Set<Column> get primaryKey => {k};
}
