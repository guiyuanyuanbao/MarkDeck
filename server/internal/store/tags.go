package store

import (
	"database/sql"
	"fmt"
	"strings"
)

// TagInfo describes one tag with its live-bookmark usage count.
type TagInfo struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// ListTags returns all tags with counts over non-deleted bookmarks.
// LIKE needs an explicit ESCAPE or '\_' matches a literal backslash prefix,
// not an underscore — internal `_`-prefixed tags would leak through.
func (s *Store) ListTags() ([]TagInfo, error) {
	rows, err := s.DB.Query(`SELECT bt.tag, COUNT(*)
		FROM bookmark_tags bt
		JOIN bookmarks b ON b.id = bt.bookmark_id
		WHERE b.deleted_at = 0 AND bt.tag NOT LIKE '\_%' ESCAPE '\'
		GROUP BY bt.tag ORDER BY bt.tag`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TagInfo
	for rows.Next() {
		var t TagInfo
		if err := rows.Scan(&t.Tag, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RenameTag renames a tag everywhere, merging into the target if it exists.
// All affected bookmarks get a revision bump so clients re-pull. `from` is
// normalized too — stored tags are lowercase, and an un-normalized from
// (e.g. "Work") matched nothing and silently affected zero rows.
func (s *Store) RenameTag(from, to string) (int, error) {
	from = normalizeTag(from)
	to = normalizeTag(to)
	if from == "" || to == "" {
		return 0, fmt.Errorf("empty tag name")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Affected bookmarks = rows holding `from` (plus rows already holding
	// `to`, since they may now carry merged state visible via tags endpoint).
	rows, err := tx.Query(`SELECT DISTINCT bookmark_id FROM bookmark_tags WHERE tag IN (?,?)`, from, to)
	if err != nil {
		return 0, err
	}
	var affected []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			affected = append(affected, id)
		}
	}
	rows.Close()

	// Move rows that don't collide with an existing (bookmark_id, to).
	if _, err := tx.Exec(`UPDATE OR IGNORE bookmark_tags SET tag=? WHERE tag=?`, to, from); err != nil {
		return 0, err
	}
	// Drop leftover collisions (bookmark already had `to`).
	if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE tag=?`, from); err != nil {
		return 0, err
	}
	for _, id := range affected {
		if _, err := bumpChange(tx, id); err != nil {
			return 0, err
		}
	}
	return len(affected), tx.Commit()
}

// DeleteTag removes a tag from all bookmarks and bumps those rows.
func (s *Store) DeleteTag(tag string) (int, error) {
	tag = normalizeTag(tag)
	if tag == "" {
		return 0, fmt.Errorf("empty tag name")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT DISTINCT bookmark_id FROM bookmark_tags WHERE tag=?`, tag)
	if err != nil {
		return 0, err
	}
	var affected []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			affected = append(affected, id)
		}
	}
	rows.Close()
	if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE tag=?`, tag); err != nil {
		return 0, err
	}
	for _, id := range affected {
		if _, err := bumpChange(tx, id); err != nil {
			return 0, err
		}
	}
	return len(affected), tx.Commit()
}

// SetTags replaces the tag set of one bookmark.
func (s *Store) SetTags(id string, tags []string, deviceID string) (*Bookmark, error) {
	if _, err := s.Get(id); err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, id); err != nil {
		return nil, err
	}
	for _, t := range tags {
		nt := normalizeTag(t)
		if nt == "" || strings.HasPrefix(nt, "_") {
			continue // drop empty tags and internal `_`-prefixed names
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag) VALUES(?,?)`,
			id, nt); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE bookmarks SET updated_at=?, device_id=? WHERE id=?`,
		Now(), deviceID, id); err != nil {
		return nil, err
	}
	if _, err := bumpChange(tx, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Get(id)
}

// Search performs FTS5 full-text search over title/url/note, falling back to
// LIKE substring scan for very short queries (trigram needs >=3 chars).
func (s *Store) Search(q string, limit int) ([]*Bookmark, error) {
	q = strings.TrimSpace(q)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if len([]rune(q)) < 3 {
		// strip BOTH LIKE wildcards (% and _) — an unescaped "_" matches any
		// character and turned a one-char query into a full-table scan
		like := "%" + strings.NewReplacer("%", "", "_", "").Replace(q) + "%"
		return queryList(s.DB, `SELECT `+scanCols+` FROM bookmarks
			WHERE deleted_at=0 AND purged=0 AND (title LIKE ? OR url LIKE ? OR note LIKE ?)
			ORDER BY updated_at DESC LIMIT ?`, like, like, like, limit)
	}
	// Quote the query as an FTS phrase so user punctuation stays literal;
	// trigram tokenizer then does substring matching.
	ftsQ := `"` + strings.ReplaceAll(q, `"`, `""`) + `"`
	return queryList(s.DB, `SELECT `+scanColsQualified+` FROM bookmarks b
		JOIN bookmarks_fts f ON f.rowid = b.rowid
		WHERE bookmarks_fts MATCH ? AND b.deleted_at=0 AND b.purged=0
		ORDER BY bm25(bookmarks_fts) LIMIT ?`, ftsQ, limit)
}

// ByIDs fetches several bookmarks preserving caller order; missing ids are skipped.
func (s *Store) ByIDs(ids []string) ([]*Bookmark, error) {
	var out []*Bookmark
	for _, id := range ids {
		b, err := s.Get(id)
		if err == nil {
			out = append(out, b)
		} else if err != ErrNotFound {
			return nil, err
		}
	}
	return out, nil
}

// Stats returns counters for the dashboard.
func (s *Store) Stats() (map[string]int64, error) {
	out := map[string]int64{}
	queries := map[string]string{
		"bookmarks": `SELECT COUNT(*) FROM bookmarks WHERE type='url' AND deleted_at=0`,
		"folders":   `SELECT COUNT(*) FROM bookmarks WHERE type='folder' AND deleted_at=0`,
		"tags":      `SELECT COUNT(DISTINCT tag) FROM bookmark_tags bt JOIN bookmarks b ON b.id=bt.bookmark_id WHERE b.deleted_at=0 AND bt.tag NOT LIKE '\_%' ESCAPE '\'`,
		"trash":     `SELECT COUNT(*) FROM bookmarks WHERE deleted_at>0 AND purged=0`,
		"archived":  `SELECT COUNT(*) FROM bookmarks WHERE archived=1 AND deleted_at=0`,
		"favorites": `SELECT COUNT(*) FROM bookmarks WHERE favorite=1 AND deleted_at=0`,
		"devices":   `SELECT COUNT(*) FROM devices`,
		"snapshots": `SELECT COUNT(*) FROM snapshots`,
	}
	for k, q := range queries {
		var n int64
		if err := s.DB.QueryRow(q).Scan(&n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, nil
}

// SettingsGet returns a settings value; empty string when missing.
func (s *Store) SettingsGet(key string) (string, error) {
	var v string
	err := s.DB.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

// SettingsSet upserts a settings value.
func (s *Store) SettingsSet(key, value string) error {
	_, err := s.DB.Exec(`INSERT INTO settings(key, value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}
