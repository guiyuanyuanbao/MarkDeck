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
	ids, err := subtreeIDs(tx, id)
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

// RestoreOpts controls RestoreWithPath.
type RestoreOpts struct {
	// ParentID pins the restore target. nil restores to the item's original
	// location, rebuilding any deleted ancestors along the way (shells).
	ParentID *string
	// IncludeChildren restores the whole subtree of a folder. false revives
	// only the folder row itself (children stay tombstoned, restorable
	// individually later).
	IncludeChildren bool
}

// RestoreWithPath restores a trashed bookmark, re-attaching it to a live
// parent. With opts.ParentID nil the original parent chain is walked upward:
// live ancestors become the anchor; tombstoned ancestors are revived as empty
// shells (their own subtrees stay tombstoned); purged ancestors — whose title
// and parent were wiped by Purge — are unrecoverable, so the chain re-roots
// at the top level. When a live folder with the same name already exists at
// the anchor — for the restored item itself as well as for shell-revived
// ancestors — the folder merges into it: the twin's id becomes the subtree
// root's parent and the original folder row stays tombstoned (URLs may share
// a name, so they never merge).
//
// Revived rows keep their ids: restoring siblings whose shared ancestors were
// shell-revived reuses the same rows, so no duplicate folders can appear.
// Already-live rows are left untouched (batch restores stay idempotent).
func (s *Store) RestoreWithPath(id string, at int64, deviceID string, opts RestoreOpts) (*Bookmark, error) {
	cur, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if cur.Purged {
		return nil, ErrNotFound
	}
	if cur.DeletedAt == 0 {
		return cur, nil // already live — idempotent no-op
	}

	// ---- resolve the anchor parent ----
	anchor := ""
	if opts.ParentID != nil {
		// pinned target: must be a live folder
		if *opts.ParentID != "" {
			p, err := s.Get(*opts.ParentID)
			if err != nil || p.DeletedAt > 0 || p.Purged || p.Type != "folder" {
				return nil, fmt.Errorf("restore target %q is not a live folder", *opts.ParentID)
			}
		}
		anchor = *opts.ParentID
	} else if cur.ParentID != "" {
		anchor, err = s.ensureLiveAncestor(cur.ParentID, at, deviceID)
		if err != nil {
			return nil, err
		}
	}

	// same-name merge for the restored item itself: a live twin folder under
	// the anchor absorbs the subtree and the original row stays tombstoned
	// (both for pinned and rebuilt anchors; a live parent can never hold a
	// live same-name twin of a trashed child, so the in-place case is
	// unaffected in practice)
	if cur.Type == "folder" {
		if twin, err := s.findSameNameFolder(anchor, cur.Title, cur.ID); err != nil {
			return nil, err
		} else if twin != "" {
			return s.mergeIntoTwin(id, twin, at, deviceID)
		}
	}

	// ---- revive ----
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if cur.Type == "folder" && opts.IncludeChildren {
		ids, err := subtreeIDs(tx, id)
		if err != nil {
			return nil, err
		}
		pos, err := maxPositionTx(tx, anchor)
		if err != nil {
			return nil, err
		}
		for i, bid := range ids {
			newPos := pos + 1 + float64(i)
			if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, parent_id=CASE WHEN id=? THEN ? ELSE parent_id END, position=CASE WHEN id=? THEN ? ELSE position END, updated_at=?, device_id=? WHERE id=?`,
				id, anchor, id, newPos, at, deviceID, bid); err != nil {
				return nil, err
			}
			if _, err := bumpChange(tx, bid); err != nil {
				return nil, err
			}
		}
	} else {
		// single row (or folder shell): revive just this row, appended after
		// the anchor's current children (a merged/re-rooted stale position
		// would collide with foreign siblings)
		pos, err := maxPositionTx(tx, anchor)
		if err != nil {
			return nil, err
		}
		if err := reviveRow(tx, id, anchor, at, deviceID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`UPDATE bookmarks SET position=? WHERE id=?`, pos+1, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Get(id)
}

// mergeIntoTwin revives the tombstoned subtree of folder id under the live
// twin folder, re-rooting the subtree's TOP-LEVEL tombstoned children to the
// twin while leaving the original folder row itself tombstoned (it stays in
// the trash as an empty shell and can be purged later). Rows that are already
// live — e.g. individually restored siblings — are left untouched.
func (s *Store) mergeIntoTwin(id, twinID string, at int64, deviceID string) (*Bookmark, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	kids, err := childrenTx(tx, id)
	if err != nil {
		return nil, err
	}
	for i, k := range kids {
		// direct children re-attach to the twin; deeper descendants keep
		// their own parents. Live children (restored earlier) are NOT moved.
		if k.DeletedAt == 0 {
			continue
		}
		if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, parent_id=?, position=?, updated_at=?, device_id=? WHERE id=? AND deleted_at > 0`,
			twinID, float64(i)+1, at, deviceID, k.ID); err != nil {
			return nil, err
		}
		// deeper descendants: revive the whole sub-tree under this child
		ids, err := subtreeIDs(tx, k.ID)
		if err != nil {
			return nil, err
		}
		for _, bid := range ids[1:] { // [0] is k itself, already revived
			if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, updated_at=?, device_id=? WHERE id=? AND deleted_at > 0`,
				at, deviceID, bid); err != nil {
				return nil, err
			}
		}
		if _, err := bumpChange(tx, k.ID); err != nil {
			return nil, err
		}
	}
	// the original folder row stays tombstoned — bump it so devices learn
	// its children moved
	if _, err := tx.Exec(`UPDATE bookmarks SET updated_at=?, device_id=? WHERE id=?`, at, deviceID, id); err != nil {
		return nil, err
	}
	if _, err := bumpChange(tx, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Get(twinID)
}

// childrenTx returns all rows (live and tombstoned) whose parent is id,
// ordered like Children does.
func childrenTx(tx *sql.Tx, parentID string) ([]*Bookmark, error) {
	return queryList(tx, `SELECT `+scanCols+` FROM bookmarks
		WHERE parent_id = ? ORDER BY position, created_at`, parentID)
}

// ensureLiveAncestor walks the parent chain upward from pid and returns the
// id of the live row the caller should re-attach under ("" = root). Tombstoned
// ancestors are shell-revived in place (their own subtrees stay tombstoned);
// purged ancestors — whose title and parent Purge wiped — break the chain and
// re-root it at the top level. depth caps pathological chains (corrupted
// parent cycles) at 100 levels, re-rooting at the top instead of looping.
// Must run OUTSIDE a tx (uses MaxPosition).
func (s *Store) ensureLiveAncestor(pid string, at int64, deviceID string) (string, error) {
	return s.ensureLiveAncestorDepth(pid, at, deviceID, 0)
}

func (s *Store) ensureLiveAncestorDepth(pid string, at int64, deviceID string, depth int) (string, error) {
	if depth > 100 {
		// pathological chain (cycle or absurd depth) — re-root at the top
		return "", nil
	}
	if pid == "" {
		return "", nil
	}
	p, err := s.Get(pid)
	if err != nil || p.Purged {
		// chain broken beyond recovery — anchor at the top level
		return "", nil
	}
	if p.DeletedAt == 0 {
		return pid, nil // live ancestor: anchor found
	}
	// tombstoned ancestor. Its own parent decides where it re-attaches;
	// resolve that first (recursion is depth-capped above).
	grandAnchor, err := s.ensureLiveAncestorDepth(p.ParentID, at, deviceID, depth+1)
	if err != nil {
		return "", err
	}
	// same-name merge: if the grand anchor already holds a live folder
	// with this name (and it isn't the row itself), merge into it and
	// leave the original row tombstoned
	if p.Title != "" {
		if twin, err := s.findSameNameFolder(grandAnchor, p.Title, p.ID); err != nil {
			return "", err
		} else if twin != "" {
			return twin, nil
		}
	}
	// shell-revive p under grandAnchor — p becomes the caller's anchor
	pos, err := s.MaxPosition(grandAnchor)
	if err != nil {
		return "", err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	if err := reviveRow(tx, p.ID, grandAnchor, at, deviceID); err != nil {
		tx.Rollback()
		return "", err
	}
	if _, err := tx.Exec(`UPDATE bookmarks SET position=? WHERE id=?`, pos+1, p.ID); err != nil {
		tx.Rollback()
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return p.ID, nil
}

// findSameNameFolder returns the id of a live folder named title directly
// under parentID, excluding excludeID. "" when none.
func (s *Store) findSameNameFolder(parentID, title, excludeID string) (string, error) {
	rows, err := s.DB.Query(`SELECT id FROM bookmarks
		WHERE parent_id = ? AND type = 'folder' AND deleted_at = 0 AND title = ? AND id != ?`,
		parentID, title, excludeID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		return id, nil
	}
	return "", rows.Err()
}

// reviveRow clears the tombstone of one row and re-parents it. Position is
// assigned by the caller when needed (maxPositionTx/MaxPosition + 1).
// Rows already revived by a concurrent restore are a no-op success (batch
// idempotency); purged rows still fail.
func reviveRow(tx *sql.Tx, id, parentID string, at int64, deviceID string) error {
	res, err := tx.Exec(`UPDATE bookmarks SET deleted_at=0, purged=0, parent_id=?, updated_at=?, device_id=? WHERE id=? AND deleted_at > 0`,
		parentID, at, deviceID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// lost a race to a concurrent restore, or the row is purged:
		// re-read and classify. Already-live = success (idempotent no-op,
		// no change-log bump); purged = real failure.
		row := tx.QueryRow(`SELECT purged FROM bookmarks WHERE id = ?`, id)
		var purged bool
		if err := row.Scan(&purged); err != nil {
			return err
		}
		if purged {
			return fmt.Errorf("row %s is not restorable (purged)", id)
		}
		return nil // already live — nothing to do
	}
	_, err = bumpChange(tx, id)
	return err
}

// maxPositionTx is MaxPosition bound to an open transaction.
func maxPositionTx(tx *sql.Tx, parentID string) (float64, error) {
	var max sql.NullFloat64
	err := tx.QueryRow(`SELECT MAX(position) FROM bookmarks
		WHERE parent_id = ? AND deleted_at = 0`, parentID).Scan(&max)
	if err != nil {
		return 0, err
	}
	return max.Float64, nil
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
	return queryList(s.DB, `SELECT `+scanCols+` FROM bookmarks
		WHERE parent_id = ? AND deleted_at = 0 ORDER BY position, created_at`, parentID)
}

// Tree returns every live row; callers assemble the hierarchy client-side.
func (s *Store) Tree() ([]*Bookmark, error) {
	return queryList(s.DB, `SELECT ` + scanCols + ` FROM bookmarks WHERE deleted_at = 0 ORDER BY parent_id, position, created_at`)
}

// Trash returns tombstoned rows still holding content.
func (s *Store) Trash() ([]*Bookmark, error) {
	return queryList(s.DB, `SELECT ` + scanCols + ` FROM bookmarks
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

// SubtreeIDs returns id and all descendant ids.
func (s *Store) SubtreeIDs(id string) ([]string, error) {
	return subtreeIDs(s.DB, id)
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
