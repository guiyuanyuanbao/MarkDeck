-- Favicons cache: fetched site icons stored as PNG bytes keyed by host.
CREATE TABLE IF NOT EXISTS favicons (
    host        TEXT PRIMARY KEY,   -- e.g. "github.com"
    content_type TEXT NOT NULL DEFAULT 'image/png',
    data        BLOB NOT NULL,
    fetched_at  INTEGER NOT NULL,   -- unix seconds, for refresh TTL
    failed_at   INTEGER NOT NULL DEFAULT 0  -- negative cache: last failed attempt
);
