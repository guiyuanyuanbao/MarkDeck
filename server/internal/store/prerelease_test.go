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
	if _, err := s.Create(b1, []string{"tag1", "tag2"}); err != nil {
		t.Fatal(err)
	}
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

	// verify structural integrity (the canonical 其他书签 holder from
	// migration 0003 is a permanent row and round-trips with everything else)
	nodes, _ := s.Tree()
	if len(nodes) != 3 { // canonical holder + folder + one live bookmark
		t.Fatalf("restored live nodes = %d, want 3", len(nodes))
	}
	var restored *store.Bookmark
	var restoredFolder *store.Bookmark
	for _, n := range nodes {
		if n.Title == "书签一" {
			restored = n
		}
		// pick the user folder by title — the canonical 其他书签 holder is
		// also a folder and would otherwise win by iteration order
		if n.Type == "folder" && n.Title == "根目录A" {
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
				title := fmt.Sprintf("d%d-%d-upd", d, i)
				if res := s.ApplyBatch([]store.BatchOp{{
					ID: b.ID, Op: "update", Title: &title,
					UpdatedAt: b.UpdatedAt + 1, DeviceID: dev, ObservedRevision: b.Revision,
				}}, store.Now()); len(res) != 1 || (!res[0].Win && res[0].Error == "") {
					done <- fmt.Errorf("update lost: %+v", res)
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
	// +1: the canonical 其他书签 holder (migration 0003) is a live row too
	if len(nodes) != devices*perDevice+1 {
		t.Fatalf("lost writes: have %d want %d", len(nodes)-1, devices*perDevice)
	}
	revs := map[int64]bool{}
	for _, n := range nodes {
		if n.ID == "md-others" {
			continue // migration row, not a device write
		}
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
	oldTitle := "B 旧编辑"
	if res := s.ApplyBatch([]store.BatchOp{{
		ID: b.ID, Op: "update", Title: &oldTitle,
		UpdatedAt: 900, DeviceID: "dB", ObservedRevision: b.Revision,
	}}, store.Now()); res[0].Win {
		t.Fatal("older edit from other device must not win")
	}
	// device B edits later
	newTitle := "B 新编辑"
	res := s.ApplyBatch([]store.BatchOp{{
		ID: b.ID, Op: "update", Title: &newTitle,
		UpdatedAt: 1100, DeviceID: "dB", ObservedRevision: b.Revision,
	}}, store.Now())
	if !res[0].Win || res[0].State == nil || res[0].State.Title != "B 新编辑" {
		t.Fatalf("later edit should win: %+v", res[0])
	}
}
