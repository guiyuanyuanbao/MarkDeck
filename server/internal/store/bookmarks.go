package store

import (
	"database/sql"
	"fmt"
	"strings"
)

// Create inserts a new bookmark row and records a change-log entry.
// It returns the row with Revision filled in. An empty ID gets a fresh UUID.
func (s *Store) Create(b *Bookmark, tags []string) (*Bookmark, error) {
	if b.Type != "folder" && b.Type != "url" {
		return nil, fmt.Errorf("invalid type %q", b.Type)
	}
	if b.ID == "" {
		var err error
		if b.ID, err = NewUUID(); err != nil {
			return nil, err
		}
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if b.CreatedAt == 0 {
		b.CreatedAt = Now()
	}
	if b.UpdatedAt == 0 {
		b.UpdatedAt = b.CreatedAt
	}
	_, err = tx.Exec(`INSERT INTO bookmarks
		(id, parent_id, type, title, url, note, favorite, archived, position,
		 deleted_at, purged, updated_at, device_id, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		b.ID, b.ParentID, b.Type, b.Title, b.URL, b.Note,
		boolInt(b.Favorite), boolInt(b.Archived), b.Position,
		b.DeletedAt, boolInt(b.Purged), b.UpdatedAt, b.DeviceID, b.CreatedAt)
	if err != nil {
		return nil, err
	}
	for _, t := range tags {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag) VALUES(?,?)`,
			b.ID, normalizeTag(t)); err != nil {
			return nil, err
		}
	}
	rev, err := bumpChange(tx, b.ID)
	if err != nil {
		return nil, err
	}
	b.Revision = rev
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	b.Tags = loadTags(s.DB, b.ID)
	return b, nil
}

// Update applies an LWW merge of the incoming fields against the stored row.
// win=false means the incoming change loses the LWW race: the row stays, but
// the caller still gets the current authoritative state. A change entry is
// only bumped when something actually changed.
func (s *Store) UpdateLWW(in *Bookmark, tags []string) (*Bookmark, bool, error) {
	cur, err := s.Get(in.ID)
	if err != nil {
		return nil, false, err
	}
	if cur.UpdatedAt > in.UpdatedAt {
		return cur, false, nil
	}
	if cur.UpdatedAt == in.UpdatedAt {
		// Same second. Distinct devices: higher device id wins (deterministic).
		// Same device: the device's own later edit always wins.
		if cur.DeviceID != in.DeviceID {
			if cur.DeviceID > in.DeviceID {
				return cur, false, nil
			}
		}
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`UPDATE bookmarks SET
		parent_id=?, type=?, title=?, url=?, note=?, favorite=?, archived=?,
		position=?, deleted_at=?, purged=?, updated_at=?, device_id=?
		WHERE id=?`,
		in.ParentID, in.Type, in.Title, in.URL, in.Note,
		boolInt(in.Favorite), boolInt(in.Archived), in.Position,
		in.DeletedAt, boolInt(in.Purged), in.UpdatedAt, in.DeviceID, in.ID)
	if err != nil {
		return nil, false, err
	}
	if tags != nil {
		if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, in.ID); err != nil {
			return nil, false, err
		}
		for _, t := range tags {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag) VALUES(?,?)`,
				in.ID, normalizeTag(t)); err != nil {
				return nil, false, err
			}
		}
	}
	rev, err := bumpChange(tx, in.ID)
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	out, err := s.Get(in.ID)
	if err != nil {
		return nil, false, err
	}
	out.Revision = rev
	return out, true, nil
}

// TouchRevision bumps the change log without altering row content (used by
// tag renames that don't touch the bookmark row itself).
func (s *Store) TouchRevision(id string) (int64, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rev, err := bumpChange(tx, id)
	if err != nil {
		return 0, err
	}
	return rev, tx.Commit()
}

// DeleteSoft moves a bookmark (and recursively, its subtree) to trash by
// setting deleted_at. Rows remain as tombstones.
func (s *Store) DeleteSoft(id string, at int64, deviceID string) ([]string, error) {
	if _, err := s.Get(id); err != nil {
		return nil, err
	}
	ids, err := s.SubtreeIDs(id)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, bid := range ids {
		if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=?, purged=0, updated_at=?, device_id=? WHERE id=?`,
			at, at, deviceID, bid); err != nil {
			return nil, err
		}
		if _, err := bumpChange(tx, bid); err != nil {
			return nil, err
		}
	}
	return ids, tx.Commit()
}

// Purge zeroes a tombstoned row's content but keeps the tombstone so other
// devices can learn the deletion permanently.
func (s *Store) Purge(id string, at int64, deviceID string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, id); err != nil {
		return err
	}
	res, err := tx.Exec(`UPDATE bookmarks SET
		parent_id='', title='', url='', note='', deleted_at=?, purged=1,
		updated_at=?, device_id=? WHERE id=? AND deleted_at > 0`,
		at, at, deviceID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := bumpChange(tx, id); err != nil {
		return err
	}
	return tx.Commit()
}

// Restore removes the tombstone from a trashed bookmark (and, if its parent
// chain was also deleted, re-parents to root so it stays reachable).
func (s *Store) Restore(id string, at int64, deviceID string) (*Bookmark, error) {
	cur, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if cur.DeletedAt == 0 {
		return cur, nil
	}
	parent := cur.ParentID
	if parent != "" {
		if p, err := s.Get(parent); err != nil || p.DeletedAt > 0 || p.Purged {
			parent = "" // re-attach to root; position recalculated below
		}
	}
	pos, err := s.MaxPosition(parent)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, parent_id=?, position=?, updated_at=?, device_id=? WHERE id=?`,
		parent, pos+1, at, deviceID, id); err != nil {
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

// Get returns one bookmark by id (including tombstones).
func (s *Store) Get(id string) (*Bookmark, error) {
	row := s.DB.QueryRow(`SELECT `+scanCols+` FROM bookmarks WHERE id = ?`, id)
	b, err := scanBookmark(row.Scan)
	if err != nil {
		return nil, err
	}
	b.Tags = loadTags(s.DB, id)
	return b, nil
}

// Children returns the live (non-deleted) children of a parent ordered by position.
func (s *Store) Children(parentID string) ([]*Bookmark, error) {
	return s.queryList(`SELECT `+scanCols+` FROM bookmarks
		WHERE parent_id = ? AND deleted_at = 0 ORDER BY position, created_at`, parentID)
}

// Tree returns every live row; callers assemble the hierarchy client-side.
func (s *Store) Tree() ([]*Bookmark, error) {
	return s.queryList(`SELECT ` + scanCols + ` FROM bookmarks WHERE deleted_at = 0 ORDER BY parent_id, position, created_at`)
}

// Trash returns tombstoned rows still holding content.
func (s *Store) Trash() ([]*Bookmark, error) {
	return s.queryList(`SELECT ` + scanCols + ` FROM bookmarks
		WHERE deleted_at > 0 AND purged = 0 ORDER BY deleted_at DESC`)
}

// ChangesSince returns rows whose revision > since, oldest first. Purged
// tombstones are included so clients learn deletions.
func (s *Store) ChangesSince(since int64, limit int) ([]*Bookmark, int64, error) {
	if limit <= 0 || limit > 5000 {
		limit = 2000
	}
	// Rows changed by a change-entry with seq > since. A row may have several
	// entries; dedupe by taking rows via revision (last entry seq).
	// The returned head is the highest revision IN THIS PAGE, not the global
	// max seq: callers save head as their next `since`, so returning the
	// global value when the page was truncated would silently skip every
	// row beyond the limit (large imports never fully synced).
	rows, err := s.DB.Query(`SELECT `+scanCols+` FROM bookmarks
		WHERE revision > ? ORDER BY revision ASC LIMIT ?`, since, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*Bookmark
	for rows.Next() {
		b, err := scanBookmark(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	for _, b := range out {
		b.Tags = loadTags(s.DB, b.ID)
	}
	// head = last revision in the page; equals the global max only when the
	// whole backlog fits in one page
	var head int64
	if len(out) > 0 {
		head = out[len(out)-1].Revision
	} else if err := s.DB.QueryRow(`SELECT COALESCE(MAX(revision),?) FROM bookmarks`, since).Scan(&head); err != nil {
		return nil, 0, err
	}
	return out, head, nil
}

// MaxPosition returns the highest position among live children of parent.
func (s *Store) MaxPosition(parentID string) (float64, error) {
	var max sql.NullFloat64
	err := s.DB.QueryRow(`SELECT MAX(position) FROM bookmarks
		WHERE parent_id = ? AND deleted_at = 0`, parentID).Scan(&max)
	if err != nil {
		return 0, err
	}
	return max.Float64, nil
}

// MaxRevision is the global head revision (the latest change-log seq that
// any row carries). Status display uses it; pull uses page-scoped heads.
func (s *Store) MaxRevision() (int64, error) {
	var max int64
	err := s.DB.QueryRow(`SELECT COALESCE(MAX(revision),0) FROM bookmarks`).Scan(&max)
	return max, err
}

// SubtreeIDs returns id and all descendant ids (depth-first).
func (s *Store) SubtreeIDs(id string) ([]string, error) {
	ids := []string{id}
	frontier := []string{id}
	for len(frontier) > 0 {
		next := []string{}
		for _, pid := range frontier {
			rows, err := s.DB.Query(`SELECT id FROM bookmarks WHERE parent_id = ?`, pid)
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

// Move re-parents a node, rejecting moves into its own subtree.
func (s *Store) Move(id, newParent string, position float64, at int64, deviceID string) (*Bookmark, error) {
	sub, err := s.SubtreeIDs(id)
	if err != nil {
		return nil, err
	}
	for _, sid := range sub {
		if sid == newParent {
			return nil, fmt.Errorf("cannot move a folder into its own subtree")
		}
	}
	if _, err := s.Get(newParent); newParent != "" && err != nil {
		return nil, err
	}
	b, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	b.ParentID = newParent
	b.Position = position
	b.UpdatedAt = at
	b.DeviceID = deviceID
	if b.DeletedAt > 0 {
		b.DeletedAt = 0 // moving out of trash restores it
	}
	out, _, err := s.UpdateLWW(b, nil)
	return out, err
}

// Reorder assigns fresh positions (index order) to the given sibling ids.
func (s *Store) Reorder(parentID string, orderedIDs []string, at int64, deviceID string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, id := range orderedIDs {
		if _, err := tx.Exec(`UPDATE bookmarks SET parent_id=?, position=?, updated_at=?, device_id=? WHERE id=? AND deleted_at=0`,
			parentID, float64(i+1), at, deviceID, id); err != nil {
			return err
		}
		if _, err := bumpChange(tx, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- internal helpers ----

func bumpChange(tx *sql.Tx, id string) (int64, error) {
	at := Now()
	res, err := tx.Exec(`INSERT INTO changes(bookmark_id, at) VALUES(?,?)`, id, at)
	if err != nil {
		return 0, err
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE bookmarks SET revision=? WHERE id=?`, seq, id); err != nil {
		return 0, err
	}
	return seq, nil
}

func loadTags(db *sql.DB, id string) []string {
	rows, err := db.Query(`SELECT tag FROM bookmark_tags WHERE bookmark_id=? ORDER BY tag`, id)
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

func (s *Store) queryList(q string, args ...any) ([]*Bookmark, error) {
	rows, err := s.DB.Query(q, args...)
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
		b.Tags = loadTags(s.DB, b.ID)
	}
	return out, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// normalizeTag trims, collapses internal whitespace and lowercases the tag
// so "Go Lang" and "go lang" share one entry.
func normalizeTag(t string) string {
	t = strings.Join(strings.Fields(t), " ")
	return strings.ToLower(t)
}
