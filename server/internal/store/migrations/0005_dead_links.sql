-- 0005: dead_links table replaces _dead:/_checked: pseudo-tags.
-- Polluting the user-facing tag list with internal state was a design
-- mistake; status now lives in its own table keyed by bookmark.
CREATE TABLE IF NOT EXISTS dead_links (
    bookmark_id TEXT PRIMARY KEY,
    status      TEXT NOT NULL,          -- ok | dead | http:NNN | blocked:NNN
    checked_at  INTEGER NOT NULL
);
