// Shared SQL helpers. store historically kept DB-bound and tx-bound twins
// of every query (loadTags/loadTagsTx, queryList/queryListTx, insert/update
// SQL duplicated between bookmarks.go and batch.go); the querier interface
// collapses each pair into one function that works for both.
package store

import (
	"database/sql"
)

// querier is satisfied by both *sql.DB and *sql.Tx.
type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// insertBookmark runs the shared INSERT (same statement as batch replay).
func insertBookmark(q querier, b *Bookmark) error {
	_, err := q.Exec(`INSERT INTO bookmarks
		(id, parent_id, type, title, url, note, favorite, archived, position,
		 deleted_at, purged, updated_at, device_id, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		b.ID, b.ParentID, b.Type, b.Title, b.URL, b.Note,
		boolInt(b.Favorite), boolInt(b.Archived), b.Position,
		b.DeletedAt, boolInt(b.Purged), b.UpdatedAt, b.DeviceID, b.CreatedAt)
	return err
}

// updateBookmark runs the shared UPDATE (full-row overwrite, LWW callers
// decide whether the incoming row wins before reaching here).
func updateBookmark(q querier, b *Bookmark) error {
	_, err := q.Exec(`UPDATE bookmarks SET
		parent_id=?, type=?, title=?, url=?, note=?, favorite=?, archived=?,
		position=?, deleted_at=?, purged=?, updated_at=?, device_id=?
		WHERE id=?`,
		b.ParentID, b.Type, b.Title, b.URL, b.Note,
		boolInt(b.Favorite), boolInt(b.Archived), b.Position,
		b.DeletedAt, boolInt(b.Purged), b.UpdatedAt, b.DeviceID, b.ID)
	return err
}

// setTags replaces a row's tag set. nil tags = leave tags untouched (LWW
// "field not in patch" semantics); empty slice = clear all tags.
func setTags(q querier, id string, tags []string) error {
	if tags == nil {
		return nil
	}
	if _, err := q.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, id); err != nil {
		return err
	}
	for _, t := range tags {
		if _, err := q.Exec(`INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag) VALUES(?,?)`,
			id, normalizeTag(t)); err != nil {
			return err
		}
	}
	return nil
}

// loadTags returns a row's tags sorted; on query error it logs nothing and
// returns nil (tags are cosmetic on read paths — never block the tree).
func loadTags(q querier, id string) []string {
	rows, err := q.Query(`SELECT tag FROM bookmark_tags WHERE bookmark_id=? ORDER BY tag`, id)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var tags []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			tags = append(tags, t)
		}
	}
	return tags
}

// queryList runs a bookmark SELECT returning scanCols-shaped rows and
// hydrates tags per row.
func queryList(q querier, query string, args ...any) ([]*Bookmark, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Bookmark
	for rows.Next() {
		b, err := scanBookmark(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, b := range out {
		b.Tags = loadTags(q, b.ID)
	}
	return out, nil
}

// subtreeIDs returns the subtree of ids rooted at id (inclusive), BFS level
// by level. No recursive CTE: the tree is shallow and MaxOpenConns is 1, so
// per-level point queries are simpler and effectively free.
func subtreeIDs(q querier, id string) ([]string, error) {
	ids := []string{id}
	frontier := []string{id}
	for len(frontier) > 0 {
		next := []string{}
		for _, pid := range frontier {
			rows, err := q.Query(`SELECT id FROM bookmarks WHERE parent_id = ?`, pid)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var cid string
				if err := rows.Scan(&cid); err != nil {
					rows.Close()
					return nil, err
				}
				next = append(next, cid)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
		}
		ids = append(ids, next...)
		frontier = next
	}
	return ids, nil
}
