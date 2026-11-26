package store

import (
	"database/sql"
)

// Read-only tree queries: single-row get, children, full tree, trash,
// position/revision heads, subtree id enumeration.

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
	return queryList(s.DB, `SELECT `+scanCols+` FROM bookmarks WHERE deleted_at = 0 ORDER BY parent_id, position, created_at`)
}

// Trash returns tombstoned rows still holding content.
func (s *Store) Trash() ([]*Bookmark, error) {
	return queryList(s.DB, `SELECT `+scanCols+` FROM bookmarks
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
