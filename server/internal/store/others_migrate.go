package store

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
)

// canonicalOthersID is the fixed server id of the ONE canonical 其他书签
// folder. Every device's browser other-bookmarks root binds to it
// structurally (the /api/sync/tree response carries it); it is never stored
// in any client-side mapping table.
const canonicalOthersID = "md-others"

// CanonicalOthersID exposes the fixed holder id (sync handler response).
func CanonicalOthersID() string { return canonicalOthersID }

// MigrateOthersHolders merges the content of every legacy per-device holder
// (id prefix "others-", created client-side by pre-0.1.0 extensions) into
// the canonical holder, then deletes the holders. Called after migrate()
// from Open — the SQL migration only inserts the canonical row; the merge
// needs ordered tree traversal, which lives here.
//
// Merge semantics: holder children move under the canonical holder at the
// tail; URL bookmarks dedupe by normalized URL within the canonical holder
// (first occurrence wins, later same-URL rows are trashed); folder trees
// merge by title (same-named folder collapses; children recurse). Whole-
// subtree moves bump a revision per moved row so every device sees them.
func (s *Store) MigrateOthersHolders() error {
	// does the canonical holder exist? (fresh installs: migration 0003
	// created it; belt-and-suspenders here in case of manual tampering)
	if _, err := s.Get(canonicalOthersID); err != nil {
		if err != ErrNotFound {
			return err
		}
		at := Now()
		if _, err := s.Create(&Bookmark{
			ID: canonicalOthersID, Type: "folder", Title: "其他书签",
			Position: 9999, UpdatedAt: at, DeviceID: "migration", CreatedAt: at,
		}, nil); err != nil {
			return fmt.Errorf("create canonical others holder: %w", err)
		}
	}

	holders, err := s.DB.Query(`SELECT id FROM bookmarks WHERE id LIKE 'others-%' AND deleted_at = 0 AND id != ?`,
		canonicalOthersID)
	if err != nil {
		return err
	}
	var holderIDs []string
	for holders.Next() {
		var id string
		if err := holders.Scan(&id); err != nil {
			holders.Close()
			return err
		}
		holderIDs = append(holderIDs, id)
	}
	holders.Close()
	if err := holders.Err(); err != nil {
		return err
	}
	if len(holderIDs) == 0 {
		return nil
	}
	log.Printf("migration: merging %d legacy others-holder(s) into %s", len(holderIDs), canonicalOthersID)

	at := Now()
	for _, hid := range holderIDs {
		kids, err := s.Children(hid)
		if err != nil {
			return fmt.Errorf("list holder %s children: %w", hid, err)
		}
		// build the canonical holder's normalized-URL index once per holder
		// merge (it grows as we merge)
		for _, kid := range kids {
			if err := s.mergeIntoOthers(kid.ID, canonicalOthersID, at); err != nil {
				return fmt.Errorf("merge %s into %s: %w", kid.ID, canonicalOthersID, err)
			}
		}
		// holder is now empty: hard-delete the row itself (destructive
		// refactor — the tombstone would just be noise; every device
		// re-binds to the canonical holder on its first 0.1.0 reconcile)
		tx, err := s.DB.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM bookmark_tags WHERE bookmark_id=?`, hid); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`DELETE FROM bookmarks WHERE id=?`, hid); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`DELETE FROM changes WHERE bookmark_id=?`, hid); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// mergeIntoOthers moves (or merges) the subtree rooted at id into
// targetParent. URL nodes dedupe by normalized URL against the target's
// existing live URL children; folders merge by title.
func (s *Store) mergeIntoOthers(id, targetParent string, at int64) error {
	node, err := s.Get(id)
	if err != nil {
		return err // vanished mid-merge: nothing to do
	}
	if node.DeletedAt > 0 {
		return nil // trashed content stays trashed
	}

	if node.Type == "url" {
		dup, err := s.findOtherDupURL(targetParent, node.URL)
		if err != nil {
			return err
		}
		if dup != "" {
			// duplicate of content already in the canonical holder: trash
			// the copy (content survives under the canonical row)
			_, err := s.DeleteSoft(id, at, "migration")
			return err
		}
		pos, err := s.MaxPosition(targetParent)
		if err != nil {
			return err
		}
		_, err = s.Move(id, targetParent, pos+1, at, "migration")
		return err
	}

	// folder: collapse into a same-named folder under targetParent
	merged, merr := s.findOtherDupFolder(targetParent, node.Title)
	if merr != nil {
		return merr
	}
	if merged != "" {
		kids, err := s.Children(id)
		if err != nil {
			return err
		}
		for _, kid := range kids {
			if err := s.mergeIntoOthers(kid.ID, merged, at); err != nil {
				return err
			}
		}
		// node is now empty; trash it (its content moved out)
		_, derr := s.DeleteSoft(id, at, "migration")
		return derr
	}

	pos, err := s.MaxPosition(targetParent)
	if err != nil {
		return err
	}
	if _, err := s.Move(id, targetParent, pos+1, at, "migration"); err != nil {
		return err
	}
	return nil
}

// findOtherDupURL returns the id of a live URL row under parent whose
// normalized URL matches raw ("" when none).
func (s *Store) findOtherDupURL(parent, raw string) (string, error) {
	kids, err := s.Children(parent)
	if err != nil {
		return "", err
	}
	want := normMigrateURL(raw)
	for _, k := range kids {
		if k.Type == "url" && normMigrateURL(k.URL) == want {
			return k.ID, nil
		}
	}
	return "", nil
}

// findOtherDupFolder returns the id of a live folder under parent with the
// same title ("" when none).
func (s *Store) findOtherDupFolder(parent, title string) (string, error) {
	kids, err := s.Children(parent)
	if err != nil {
		return "", err
	}
	for _, k := range kids {
		if k.Type == "folder" && strings.TrimSpace(k.Title) == strings.TrimSpace(title) {
			return k.ID, nil
		}
	}
	return "", nil
}

// normMigrateURL canonicalizes for holder-merge dedupe: trim, lowercase,
// strip trailing slashes. Same granularity the old import merge applied
// within a folder.
func normMigrateURL(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	return strings.TrimRight(raw, "/")
}

var _ = sql.ErrNoRows // keep import if helpers change
