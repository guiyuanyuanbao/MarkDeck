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
	if err := insertBookmark(tx, b); err != nil {
		return nil, err
	}
	if err := setTags(tx, b.ID, tags); err != nil {
		return nil, err
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

	if err := updateBookmark(tx, in); err != nil {
		return nil, false, err
	}
	if err := setTags(tx, in.ID, tags); err != nil {
		return nil, false, err
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
