-- MarkDeck initial schema (v1).

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id         TEXT PRIMARY KEY,            -- uuid
    parent_id  TEXT NOT NULL DEFAULT '',    -- '' = root
    type       TEXT NOT NULL CHECK (type IN ('folder', 'url')),
    title      TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    favorite   INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    position   REAL NOT NULL DEFAULT 0,
    deleted_at INTEGER NOT NULL DEFAULT 0,  -- unix seconds; >0 = tombstone (trash)
    purged     INTEGER NOT NULL DEFAULT 0,  -- 1 = permanently removed, row kept as tombstone
    revision   INTEGER NOT NULL DEFAULT 0,  -- last change seq for this row
    updated_at INTEGER NOT NULL DEFAULT 0,  -- unix seconds, LWW clock
    device_id  TEXT NOT NULL DEFAULT '',    -- last writer device
    created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_parent ON bookmarks(parent_id, position);
CREATE INDEX IF NOT EXISTS idx_bookmarks_rev    ON bookmarks(revision);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url    ON bookmarks(url) WHERE type = 'url';
CREATE INDEX IF NOT EXISTS idx_bookmarks_deleted ON bookmarks(deleted_at) WHERE deleted_at > 0;

CREATE TABLE IF NOT EXISTS bookmark_tags (
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON bookmark_tags(tag);

-- Global change log: source of truth for the monotonic revision counter.
CREATE TABLE IF NOT EXISTS changes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    bookmark_id TEXT NOT NULL,
    at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,             -- sha256 of token
    csrf       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,             -- uuid
    name       TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL,                -- sha256 hex of bearer token
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL DEFAULT 0
);

-- FTS5 external-content index over bookmarks. trigram tokenizer gives
-- substring matching and works for CJK without dictionary words.
CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
    title, url, note,
    content='bookmarks', content_rowid='rowid',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS bookmarks_fts_insert AFTER INSERT ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(rowid, title, url, note)
    VALUES (new.rowid, new.title, new.url, new.note);
END;
CREATE TRIGGER IF NOT EXISTS bookmarks_fts_delete AFTER DELETE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, note)
    VALUES ('delete', old.rowid, old.title, old.url, old.note);
END;
CREATE TRIGGER IF NOT EXISTS bookmarks_fts_update AFTER UPDATE ON bookmarks BEGIN
    INSERT INTO bookmarks_fts(bookmarks_fts, rowid, title, url, note)
    VALUES ('delete', old.rowid, old.title, old.url, old.note);
    INSERT INTO bookmarks_fts(rowid, title, url, note)
    VALUES (new.rowid, new.title, new.url, new.note);
END;

CREATE TABLE IF NOT EXISTS snapshots (
    id         TEXT PRIMARY KEY,             -- uuid
    created_at INTEGER NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    file       TEXT NOT NULL,                -- basename inside SnapshotDir
    cause      TEXT NOT NULL DEFAULT 'manual' -- manual | daily | pre-restore
);
