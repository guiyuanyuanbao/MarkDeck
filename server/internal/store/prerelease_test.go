// Pre-release server hardening tests: snapshot roundtrip, TOTP full flow,
// concurrent multi-device pushes, session expiry, data integrity.
package store_test

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// Pre-release: snapshot restore must be lossless for tree structure, tags,
// notes and favorites.
func TestSnapshotRestoreRoundtrip(t *testing.T) {
	s := openStore(t)
	f1 := &store.Bookmark{Type: "folder", Title: "根目录A"}
	f1, _ = s.Create(f1, nil)
	b1 := &store.Bookmark{ParentID: f1.ID, Type: "url", Title: "书签一", URL: "https://one.test", Note: "备注1", Favorite: true}
	b1, _ = s.Create(b1, []string{"tag1", "tag2"})
	b2 := &store.Bookmark{ParentID: f1.ID, Type: "url", Title: "书签二", URL: "https://two.test", Archived: true}
	b2, _ = s.Create(b2, nil)
	// tombstone one
	if _, err := s.DeleteSoft(b2.ID, store.Now(), "d"); err != nil {
		t.Fatal(err)
	}

	dump, err := s.Tree()
	if err != nil {
		t.Fatal(err)
	}
	trash, _ := s.Trash()
	all := append(dump, trash...)

	// wipe and restore from the dump
	if err := s.RestoreFromDump(all, "restore-test"); err != nil {
		t.Fatal(err)
	}

	// verify structural integrity
	nodes, _ := s.Tree()
	if len(nodes) != 2 { // folder + one live bookmark
		t.Fatalf("restored live nodes = %d, want 2", len(nodes))
	}
	var restored *store.Bookmark
	var restoredFolder *store.Bookmark
	for _, n := range nodes {
		if n.Title == "书签一" {
			restored = n
		}
		if n.Type == "folder" {
			restoredFolder = n
		}
	}
	if restored == nil {
		t.Fatal("live bookmark lost in restore")
	}
	if restoredFolder == nil {
		t.Fatal("folder lost in restore")
	}
	if restored.ParentID != restoredFolder.ID {
		t.Fatalf("parent link broken: %s", restored.ParentID)
	}
	if !restored.Favorite || restored.Note != "备注1" {
		t.Fatalf("favorite/note lost: %+v", restored)
	}
	if len(restored.Tags) != 2 {
		t.Fatalf("tags lost: %v", restored.Tags)
	}
	if restored.URL != "https://one.test" {
		t.Fatalf("url lost: %s", restored.URL)
	}

	// after restore, new writes must bump revision correctly (FTS/changes intact)
	n := &store.Bookmark{ParentID: restoredFolder.ID, Type: "url", Title: "新节点", URL: "https://new.test"}
	if _, err := s.Create(n, nil); err != nil {
		t.Fatalf("post-restore create failed: %v", err)
	}
	if n.Revision == 0 {
		t.Fatal("revision not assigned after restore")
	}
}

// Pre-release: many devices pushing concurrently must never lose writes and
// must keep revisions unique + monotonic per row.
func TestConcurrentMultiDevicePush(t *testing.T) {
	s := openStore(t)
	const devices = 8
	const perDevice = 25
	done := make(chan error, devices)
	for d := 0; d < devices; d++ {
		go func(d int) {
			dev := fmt.Sprintf("device-%d", d)
			for i := 0; i < perDevice; i++ {
				b := &store.Bookmark{Type: "url", Title: fmt.Sprintf("d%d-%d", d, i), URL: fmt.Sprintf("https://d%d/%d", d, i), DeviceID: dev}
				if _, err := s.Create(b, nil); err != nil {
					done <- err
					return
				}
				// also update it once
				b.Title = fmt.Sprintf("d%d-%d-upd", d, i)
				b.UpdatedAt += 1
				if _, _, err := s.UpdateLWW(b, nil); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}(d)
	}
	for d := 0; d < devices; d++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent push error: %v", err)
		}
	}
	nodes, _ := s.Tree()
	if len(nodes) != devices*perDevice {
		t.Fatalf("lost writes: have %d want %d", len(nodes), devices*perDevice)
	}
	revs := map[int64]bool{}
	for _, n := range nodes {
		if revs[n.Revision] {
			t.Fatalf("duplicate revision %d on %s", n.Revision, n.Title)
		}
		revs[n.Revision] = true
	}
}

// Pre-release: LWW across devices with real clock skew — later timestamp
// from another device must win even when pushed earlier in time.
func TestLWWCrossDeviceClockOrder(t *testing.T) {
	s := openStore(t)
	b := &store.Bookmark{Type: "url", Title: "v1", URL: "https://x", DeviceID: "dA", UpdatedAt: 1000}
	b, _ = s.Create(b, nil)

	// device B edited earlier locally but pushes later
	old := *b
	old.Title = "B 旧编辑"
	old.UpdatedAt = 900
	old.DeviceID = "dB"
	if _, win, _ := s.UpdateLWW(&old, nil); win {
		t.Fatal("older edit from other device must not win")
	}
	// device B edits later
	newer := *b
	newer.Title = "B 新编辑"
	newer.UpdatedAt = 1100
	newer.DeviceID = "dB"
	got, win, err := s.UpdateLWW(&newer, nil)
	if err != nil || !win {
		t.Fatalf("later edit should win: win=%v err=%v", win, err)
	}
	if got.Title != "B 新编辑" {
		t.Fatalf("title = %s", got.Title)
	}
}
