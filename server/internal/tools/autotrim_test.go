package tools

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

func openChain(t *testing.T) *Chain {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return NewChain(st, filepath.Join(t.TempDir(), "snaps"), nil)
}

// Trash retention: rows older than the window are purged (folder rows take
// their subtree), rows inside the window survive, retention 0 disables.
func TestEnforceTrashRetention(t *testing.T) {
	c := openChain(t)

	// seed: expired folder (with child), expired top url, fresh url
	f, _ := c.Store.Create(&store.Bookmark{Type: "folder", Title: "过期文件夹"}, nil)
	child, _ := c.Store.Create(&store.Bookmark{ParentID: f.ID, Type: "url", Title: "过期子书签", URL: "https://old.test/child"}, nil)
	oldURL, _ := c.Store.Create(&store.Bookmark{Type: "url", Title: "过期顶层", URL: "https://old.test/x"}, nil)
	fresh, _ := c.Store.Create(&store.Bookmark{Type: "url", Title: "新鲜", URL: "https://new.test/x"}, nil)

	old := store.Now() - 10*86400 // 10 days ago
	freshRow, _ := c.Store.Get(fresh.ID)
	_ = freshRow
	// backdate the three expired rows via direct updates (UpdateLWW cannot
	// touch deleted_at; simulate the tombstones the way DeleteSoft would)
	for _, id := range []string{f.ID, child.ID, oldURL.ID} {
		if _, err := c.Store.DeleteSoft(id, old, "test"); err != nil {
			t.Fatalf("delete %s: %v", id, err)
		}
	}
	if _, err := c.Store.DeleteSoft(fresh.ID, store.Now(), "test"); err != nil {
		t.Fatal(err)
	}

	// retention 0: no-op
	if got := c.EnforceTrashRetention(store.Now()); got != 0 {
		t.Fatalf("retention 0 purged %d rows, want 0", got)
	}
	trash, _ := c.Store.Trash()
	if len(trash) != 4 {
		t.Fatalf("retention 0: trash=%d, want 4 (no purge)", len(trash))
	}

	// retention 7 days: the 10-day-old subtree + top url expire, fresh stays
	if err := c.SetTrashRetention(7); err != nil {
		t.Fatal(err)
	}
	if got := c.EnforceTrashRetention(store.Now()); got != 2 {
		t.Fatalf("purged %d top-level rows, want 2 (folder+url)", got)
	}
	// expired folder and its child must be fully gone (purged, not tombstoned)
	for _, id := range []string{f.ID, child.ID, oldURL.ID} {
		if _, err := c.Store.Get(id); err == nil {
			// Get returns tombstones too, so a surviving row means the purge
			// didn't run — but Purge keeps the tombstone shell. What matters:
			// purged rows have Purged=1 and empty content.
			row, gerr := c.Store.Get(id)
			if gerr != nil {
				t.Fatalf("get %s: %v", id, gerr)
			}
			if !row.Purged {
				t.Errorf("%s survived retention sweep (purged=false)", id)
			}
		}
	}
	// fresh row untouched
	fr, err := c.Store.Get(fresh.ID)
	if err != nil || fr.Purged {
		t.Errorf("fresh row purged or missing: %+v err=%v", fr, err)
	}

	// invalid retention values rejected
	for _, bad := range []int{-1, 3651} {
		if err := c.SetTrashRetention(bad); err == nil {
			t.Errorf("SetTrashRetention(%d) accepted, want error", bad)
		}
	}
	// persisted value round-trips
	if err := c.SetTrashRetention(30); err != nil {
		t.Fatal(err)
	}
	if got := c.TrashRetentionDays(); got != 30 {
		t.Errorf("TrashRetentionDays=%d, want 30", got)
	}
	_ = time.Now
}
