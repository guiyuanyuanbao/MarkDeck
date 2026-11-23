package store

import (
	"database/sql"
	"errors"
	"strings"
)

// Bookmark is the single node type: folders and URL bookmarks share one row
// shape (mirroring how browsers model bookmarks as a tree).
type Bookmark struct {
	ID        string   `json:"id"`
	ParentID  string   `json:"parentId"`
	Type      string   `json:"type"` // "folder" | "url"
	Title     string   `json:"title"`
	URL       string   `json:"url,omitempty"`
	Note      string   `json:"note,omitempty"`
	Favorite  bool     `json:"favorite"`
	Archived  bool     `json:"archived"`
	Position  float64  `json:"position"`
	DeletedAt int64    `json:"deletedAt,omitempty"` // >0 = in trash
	Purged    bool     `json:"purged,omitempty"`    // tombstone after hard delete
	Revision  int64    `json:"revision"`
	UpdatedAt int64    `json:"updatedAt"`
	DeviceID  string   `json:"deviceId,omitempty"`
	CreatedAt int64    `json:"createdAt"`
	Tags      []string `json:"tags,omitempty"`

	// SkipParentCheck: sync push normalizes unknown parents itself before
	// calling Create (its rows may reference parents created EARLIER IN THE
	// SAME BATCH, which are not yet committed). REST/import handlers leave
	// this false and get full parent validation.
	SkipParentCheck bool `json:"-"`
}

// ErrNotFound is returned when a bookmark id does not exist.
var ErrNotFound = errors.New("bookmark not found")

const scanCols = `id, parent_id, type, title, url, note, favorite, archived,
	position, deleted_at, purged, revision, updated_at, device_id, created_at`

// scanColsQualified prefixes every column with "b." for join queries.
var scanColsQualified = func() string {
	parts := make([]string, 0, 15)
	for _, c := range strings.Fields(strings.ReplaceAll(scanCols, "\n", " ")) {
		parts = append(parts, "b."+strings.TrimSuffix(c, ","))
	}
	return strings.Join(parts, ", ")
}()

func scanBookmark(scan func(dest ...any) error) (*Bookmark, error) {
	b := &Bookmark{}
	var fav, arch, purged int
	err := scan(&b.ID, &b.ParentID, &b.Type, &b.Title, &b.URL, &b.Note,
		&fav, &arch, &b.Position, &b.DeletedAt, &purged, &b.Revision,
		&b.UpdatedAt, &b.DeviceID, &b.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	b.Favorite = fav == 1
	b.Archived = arch == 1
	b.Purged = purged == 1
	return b, nil
}
