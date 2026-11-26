// Trash auto-purge: enforce a retention policy on tombstoned rows. The
// hourly background job (main.go backgroundJobs) calls EnforceTrashRetention;
// each top-level tombstone whose deleted_at is older than the retention
// window is purged subtree-style (children were tombstoned transitively and
// their own deleted_at is >= the folder's, so per-row age checks are safe).
// Retention days live in settings('trash_retention_days'): 0 = never
// (default — auto-purge stays off until the admin turns it on).
package tools

import (
	"errors"
	"log"
	"strconv"
)

const retentionSettingKey = "trash_retention_days"

var errInvalidRetention = errors.New("retention days must be 0..3650")

// TrashRetentionDays reads the configured retention window in days
// (0 = auto-purge disabled).
func (c *Chain) TrashRetentionDays() int {
	raw, err := c.Store.SettingsGet(retentionSettingKey)
	if err != nil || raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// SetTrashRetention validates and persists the retention window.
func (c *Chain) SetTrashRetention(days int) error {
	if days < 0 || days > 3650 {
		return errInvalidRetention
	}
	return c.Store.SettingsSet(retentionSettingKey, strconv.Itoa(days))
}

// EnforceTrashRetention purges every top-level tombstone whose deleted_at is
// older than the retention window. No-op when retention is 0 (never). Rows
// are purged one by one (Purge handles the whole subtree per top-level row);
// failures are logged and don't abort the sweep.
func (c *Chain) EnforceTrashRetention(now int64) (purged int) {
	days := c.TrashRetentionDays()
	if days <= 0 {
		return 0
	}
	cutoff := now - int64(days)*86400
	tombstones, err := c.Store.Trash()
	if err != nil {
		log.Printf("trash auto-purge: list failed: %v", err)
		return 0
	}
	// top-level rows only: their children are always younger-or-equal
	// (a child's tombstone is stamped when the folder was deleted), so one
	// Purge call covers the whole expired subtree without double-purging
	seen := make(map[string]bool, len(tombstones))
	for _, b := range tombstones {
		seen[b.ID] = true
	}
	for _, b := range tombstones {
		if b.DeletedAt == 0 || b.DeletedAt > cutoff {
			continue // inside the window
		}
		if seen[b.ParentID] {
			continue // child of an expired folder: covered by the folder's purge
		}
		if err := c.Store.Purge(b.ID, now, "auto-purge"); err != nil {
			log.Printf("trash auto-purge: purge %s failed: %v", b.ID, err)
			continue
		}
		purged++
	}
	if purged > 0 {
		log.Printf("trash auto-purge: removed %d expired item(s) (retention %d days)", purged, days)
		if c.Broadcast != nil {
			c.Broadcast(0)
		}
	}
	return purged
}
