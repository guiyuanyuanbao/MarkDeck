package store

import (
	"os"
	"path/filepath"
)

// SnapshotRow is one backup file's metadata.
type SnapshotRow struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt"`
	Size      int64  `json:"size"`
	File      string `json:"file"`
	Cause     string `json:"cause"`
}

// InsertSnapshot registers a snapshot file.
func (s *Store) InsertSnapshot(row *SnapshotRow) error {
	_, err := s.DB.Exec(`INSERT INTO snapshots(id, created_at, size, file, cause) VALUES(?,?,?,?,?)`,
		row.ID, row.CreatedAt, row.Size, row.File, row.Cause)
	return err
}

// ListSnapshots returns rows newest first.
func (s *Store) ListSnapshots() ([]*SnapshotRow, error) {
	rows, err := s.DB.Query(`SELECT id, created_at, size, file, cause FROM snapshots ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SnapshotRow
	for rows.Next() {
		var r SnapshotRow
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.Size, &r.File, &r.Cause); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// SnapshotFile returns the absolute path of a snapshot after checking the id.
func (s *Store) SnapshotFile(id, dir string) (string, *SnapshotRow, error) {
	row := s.DB.QueryRow(`SELECT id, created_at, size, file, cause FROM snapshots WHERE id=?`, id)
	var r SnapshotRow
	if err := row.Scan(&r.ID, &r.CreatedAt, &r.Size, &r.File, &r.Cause); err != nil {
		return "", nil, ErrNotFound
	}
	// never let a stored filename escape the snapshot dir
	base := filepath.Base(r.File)
	return filepath.Join(dir, base), &r, nil
}

// DeleteSnapshot removes metadata (caller removes the file).
func (s *Store) DeleteSnapshot(id string) error {
	_, err := s.DB.Exec(`DELETE FROM snapshots WHERE id=?`, id)
	return err
}

// RestoreFromDump replaces all bookmark rows with the dump contents.
// Change-log entries are rewritten so every client re-pulls everything.
func (s *Store) RestoreFromDump(rows []*Bookmark, deviceID string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// drop old state
	if _, err := tx.Exec(`DELETE FROM bookmarks`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM bookmark_tags`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM changes`); err != nil {
		return err
	}
	// FTS external-content needs explicit clearing since rows were deleted
	// outside triggers — delete-then-rebuild keeps it consistent.
	if _, err := tx.Exec(`DELETE FROM bookmarks_fts`); err != nil {
		return err
	}

	at := Now()
	for _, b := range rows {
		if b.Purged {
			continue // don't resurrect purged tombstones
		}
		if b.DeletedAt > 0 && b.Title == "" && b.URL == "" {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO bookmarks
			(id, parent_id, type, title, url, note, favorite, archived, position,
			 deleted_at, purged, updated_at, device_id, created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			b.ID, b.ParentID, b.Type, b.Title, b.URL, b.Note,
			boolInt(b.Favorite), boolInt(b.Archived), b.Position,
			b.DeletedAt, boolInt(b.Purged), at, deviceID, b.CreatedAt); err != nil {
			return err
		}
		for _, t := range b.Tags {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO bookmark_tags(bookmark_id, tag) VALUES(?,?)`,
				b.ID, t); err != nil {
				return err
			}
		}
		// rebuild FTS rows explicitly (triggers only fire on table ops;
		// the bulk DELETE above bypassed them)
		if _, err := tx.Exec(`INSERT INTO bookmarks_fts(rowid, title, url, note)
			SELECT rowid, title, url, note FROM bookmarks WHERE id=?`, b.ID); err != nil {
			return err
		}
	}
	// fresh change log: every restored row gets one entry
	if _, err := tx.Exec(`INSERT INTO changes(bookmark_id, at)
		SELECT id, ? FROM bookmarks`, at); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE bookmarks SET revision=(SELECT seq FROM changes c WHERE c.bookmark_id=bookmarks.id)`); err != nil {
		return err
	}
	return tx.Commit()
}

var _ = os.Getenv
