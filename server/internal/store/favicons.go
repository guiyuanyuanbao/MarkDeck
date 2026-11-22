package store

import (
	"database/sql"
	"time"
)

// FaviconRow is one cached site icon.
type FaviconRow struct {
	Host        string
	ContentType string
	Data        []byte
	FetchedAt   int64
	FailedAt    int64
}

// FaviconGet returns the cached icon for host.
func (s *Store) FaviconGet(host string) (*FaviconRow, error) {
	row := s.DB.QueryRow(`SELECT host, content_type, data, fetched_at, failed_at FROM favicons WHERE host=?`, host)
	var f FaviconRow
	if err := row.Scan(&f.Host, &f.ContentType, &f.Data, &f.FetchedAt, &f.FailedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &f, nil
}

// FaviconPut stores a successfully fetched icon.
func (s *Store) FaviconPut(host, contentType string, data []byte) error {
	_, err := s.DB.Exec(`INSERT INTO favicons(host, content_type, data, fetched_at, failed_at)
		VALUES(?,?,?,?,0)
		ON CONFLICT(host) DO UPDATE SET content_type=excluded.content_type,
			data=excluded.data, fetched_at=excluded.fetched_at, failed_at=0`,
		host, contentType, data, time.Now().Unix())
	return err
}

// FaviconMarkFailed records a failed fetch (negative cache).
func (s *Store) FaviconMarkFailed(host string) error {
	_, err := s.DB.Exec(`INSERT INTO favicons(host, content_type, data, fetched_at, failed_at)
		VALUES(?,'',zeroblob(0),0,?)
		ON CONFLICT(host) DO UPDATE SET failed_at=excluded.failed_at`,
		host, time.Now().Unix())
	return err
}
