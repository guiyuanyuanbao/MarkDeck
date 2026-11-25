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
	if b.Type == "url" && b.URL == "" {
		return nil, fmt.Errorf("url bookmarks require a URL")
	}
	// parent must exist and be alive — a missing/deleted parent orphaned the
	// node invisibly (it appeared in no tree view but occupied the DB and
	// synced to devices as an unplaceable row). Only sync push may skip this
	// (it normalizes unknown parents itself before calling).
	if b.ParentID != "" && !b.SkipParentCheck {
		p, err := s.Get(b.ParentID)
		if err != nil {
			return nil, fmt.Errorf("parent %q does not exist", b.ParentID)
		}
		if p.DeletedAt > 0 {
			return nil, fmt.Errorf("parent %q is in the trash", b.ParentID)
		}
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
	return s.UpdateLWWBase(in, tags, 0)
}

// UpdateLWWBase is UpdateLWW with an authoring baseline: baseRev is the
// change-log revision the incoming op was authored against (0 = unknown).
func (s *Store) UpdateLWWBase(in *Bookmark, tags []string, baseRev int64) (*Bookmark, bool, error) {
	cur, err := s.Get(in.ID)
	if err != nil {
		return nil, false, err
	}
	if cur.UpdatedAt > in.UpdatedAt {
		return cur, false, nil
	}
	if cur.UpdatedAt == in.UpdatedAt && cur.DeviceID != in.DeviceID {
		// Same-second tie — author clocks are identical, so clock alone
		// cannot order the writes. The baseline does: an op authored against
		// the row the server already holds (baseRev >= cur.Revision) is a
		// legitimate follow-up edit and wins; an op authored against older
		// history or with no baseline at all (stale offline delete racing a
		// snapshot restore) loses the tie. Same device: its own later edit
		// always wins (edit chain).
		if cur.Revision > baseRev {
			return cur, false, nil
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
	// Purge the WHOLE subtree: soft-deleting a folder tombstoned every
	// descendant, and purging only the folder row left orphan child
	// tombstones in the trash pointing at an emptied parent forever.
	ids, err := subtreeIDsTx(tx, id)
	if err != nil {
		return err
	}
	for _, bid := range ids {
		if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, bid); err != nil {
			return err
		}
	}
	// scanned dead-link rows for purged bookmarks are noise (their bookmark
	// no longer exists); drop them in the same tx
	if _, err := tx.Exec(`DELETE FROM dead_links WHERE bookmark_id IN (`+placeholders(len(ids))+`)`, idArgs(ids)...); err != nil {
		// dead_links exists only when migration 0005 applied; tolerate older DBs
		if !strings.Contains(err.Error(), "no such table") {
			return err
		}
	}
	for _, bid := range ids {
		res, err := tx.Exec(`UPDATE bookmarks SET
			parent_id='', title='', url='', note='', deleted_at=?, purged=1,
			updated_at=?, device_id=? WHERE id=? AND deleted_at > 0`,
			at, at, deviceID, bid)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue // child already purged individually — fine
		}
		if _, err := bumpChange(tx, bid); err != nil {
			return err
		}
	}
	// the root id itself must have been a trashed row (guard unchanged)
	var n int64
	if err := tx.QueryRow(`SELECT COUNT(*) FROM bookmarks WHERE id=? AND deleted_at>0`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// placeholders builds "?,?" x n for IN clauses (ids are trusted server data,
// but placeholders keep the queries uniform).
func placeholders(n int) string {
	if n <= 0 {
		return "''"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func idArgs(ids []string) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
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
	// restoring a folder must revive its whole subtree: DeleteSoft tombstoned
	// every descendant, and without this they stayed invisible (revision
	// unchanged, so remote devices never learned they were back either)
	ids, err := s.SubtreeIDs(id)
	if err != nil {
		return nil, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for i, bid := range ids {
		newPos := pos + 1 + float64(i)
		if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, parent_id=CASE WHEN id=? THEN ? ELSE parent_id END, position=CASE WHEN id=? THEN ? ELSE position END, updated_at=?, device_id=? WHERE id=?`,
			id, parent, id, newPos, at, deviceID, bid); err != nil {
			return nil, err
		}
		if _, err := bumpChange(tx, bid); err != nil {
			return nil, err
		}
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
	// moving INTO a trashed folder re-parents the node into the void: it
	// vanishes from every tree view (parent is tombstoned) but stays alive
	if newParent != "" {
		if p, err := s.Get(newParent); err == nil && p.DeletedAt > 0 {
			return nil, fmt.Errorf("target parent is in the trash")
		}
	}
	b, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	// moving a trashed node would silently resurrect it outside the trash
	// flow (no restore event, subtree left tombstoned); the UI's restore
	// action is the only sanctioned un-delete path
	if b.DeletedAt > 0 {
		return nil, fmt.Errorf("node is in the trash; restore it before moving")
	}
	b.ParentID = newParent
	b.Position = position
	b.UpdatedAt = at
	b.DeviceID = deviceID
	// authored against the row just read: quoting its revision wins the
	// same-second LWW tie (moves within a merge batch are all same-second;
	// baseRev=0 let the tie keep the OLD row and the move silently no-oped)
	out, _, err := s.UpdateLWWBase(b, nil, b.Revision)
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
		// guard against cross-parent writes: the id must already live under
		// parentID (an order list is a permutation of its children, not a
		// reparenting tool — that's Move's job, with cycle checks)
		var pid string
		if err := tx.QueryRow(`SELECT parent_id FROM bookmarks WHERE id=? AND deleted_at=0`, id).Scan(&pid); err != nil {
			return fmt.Errorf("reorder: id %q not found or deleted", id)
		}
		if pid != parentID {
			return fmt.Errorf("reorder: id %q is not a child of %q", id, parentID)
		}
		if _, err := tx.Exec(`UPDATE bookmarks SET position=?, updated_at=?, device_id=? WHERE id=?`,
			float64(i+1), at, deviceID, id); err != nil {
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
