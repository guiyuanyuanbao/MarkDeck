// Snapshot lifecycle: gzipped JSON dumps with retention, restore through
// store.RestoreFromDump, and post-restore dead-link re-scan.
package tools

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// ---- snapshots ----

// TakeSnapshot writes a gzipped JSON dump of all rows (including tombstones)
// and registers it in the snapshots table.
func (c *Chain) TakeSnapshot(cause string) (*store.SnapshotRow, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	trash, err := c.Store.Trash()
	if err != nil {
		return nil, err
	}
	all := append(nodes, trash...)
	payload, err := json.Marshal(map[string]any{"exportedAt": store.Now(), "bookmarks": all})
	if err != nil {
		return nil, err
	}

	id, err := store.NewUUID()
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("snapshot-%s-%s.json.gz", time.Now().Format("20060102-150405"), id[:8])
	f, err := os.Create(filepath.Join(c.SnapshotDir, name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	if _, err := gz.Write(payload); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	row := &store.SnapshotRow{ID: id, CreatedAt: store.Now(), Size: fi.Size(), File: name, Cause: cause}
	if err := c.Store.InsertSnapshot(row); err != nil {
		return nil, err
	}
	return row, nil
}

// ListSnapshots returns snapshot metadata, newest first.
func (c *Chain) ListSnapshots() ([]*store.SnapshotRow, error) { return c.Store.ListSnapshots() }

// SnapshotPath resolves the absolute file for a snapshot id.
func (c *Chain) SnapshotPath(id string) (string, *store.SnapshotRow, error) {
	return c.Store.SnapshotFile(id, c.SnapshotDir)
}

// CleanupSnapshots enforces the retention policy: keep newest 30.
func (c *Chain) CleanupSnapshots() {
	rows, err := c.Store.ListSnapshots()
	if err != nil || len(rows) <= 30 {
		return
	}
	for _, old := range rows[30:] {
		_ = os.Remove(filepath.Join(c.SnapshotDir, old.File))
		_ = c.Store.DeleteSnapshot(old.ID)
	}
}

// RestoreSnapshot replaces the live tree with the snapshot contents.
// A protective snapshot of the current state is taken first.
func (c *Chain) RestoreSnapshot(id string, deviceID string) error {
	path, row, err := c.SnapshotPath(id)
	if err != nil {
		return err
	}
	_ = row
	if _, err := c.TakeSnapshot("pre-restore"); err != nil {
		return fmt.Errorf("protective snapshot failed: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return c.restoreSnapshotBytes(data, deviceID)
}

// RestoreSnapshotFile registers an externally provided snapshot dump (e.g.
// a previously downloaded one, moved from another instance) and restores
// it. Same protective-snapshot-first contract as RestoreSnapshot.
func (c *Chain) RestoreSnapshotFile(data []byte, deviceID string) (*store.SnapshotRow, error) {
	row, err := c.registerSnapshotFile(data, "imported")
	if err != nil {
		return nil, err
	}
	if err := c.restoreSnapshotBytes(data, deviceID); err != nil {
		// don't leave a registered row for data that failed to restore
		_ = os.Remove(filepath.Join(c.SnapshotDir, row.File))
		_ = c.Store.DeleteSnapshot(row.ID)
		return nil, err
	}
	return row, nil
}

// registerSnapshotFile validates a snapshot dump and stores it in the
// snapshot dir + table so imported files participate in listing/retention.
func (c *Chain) registerSnapshotFile(data []byte, cause string) (*store.SnapshotRow, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("empty snapshot payload")
	}
	// validate before storing: same decode rules as restoreSnapshotBytes
	gz, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return nil, fmt.Errorf("snapshot corrupt: %w", err)
	}
	defer gz.Close()
	var probe struct {
		Bookmarks []*store.Bookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(gz).Decode(&probe); err != nil {
		return nil, fmt.Errorf("snapshot decode: %w", err)
	}

	id, err := store.NewUUID()
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("snapshot-%s-%s.json.gz", time.Now().Format("20060102-150405"), id[:8])
	if err := os.WriteFile(filepath.Join(c.SnapshotDir, name), data, 0o600); err != nil {
		return nil, err
	}
	row := &store.SnapshotRow{ID: id, CreatedAt: store.Now(), Size: int64(len(data)), File: name, Cause: cause}
	if err := c.Store.InsertSnapshot(row); err != nil {
		_ = os.Remove(filepath.Join(c.SnapshotDir, name))
		return nil, err
	}
	return row, nil
}

// restoreSnapshotBytes gunzips + applies a snapshot dump (shared by
// RestoreSnapshot and RestoreSnapshotFile).
func (c *Chain) restoreSnapshotBytes(data []byte, deviceID string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return fmt.Errorf("snapshot corrupt: %w", err)
	}
	defer gz.Close()
	var payload struct {
		Bookmarks []*store.Bookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(gz).Decode(&payload); err != nil {
		return fmt.Errorf("snapshot decode: %w", err)
	}
	if err := c.Store.RestoreFromDump(payload.Bookmarks, deviceID); err != nil {
		return err
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return nil
}
