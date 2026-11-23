package store

import (
	"fmt"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func seed(s *Store, parent, typ, title, url string) *Bookmark {
	b := &Bookmark{ParentID: parent, Type: typ, Title: title, URL: url, DeviceID: "test"}
	out, err := s.Create(b, nil)
	if err != nil {
		panic(err)
	}
	return out
}

func TestRevisionMonotonic(t *testing.T) {
	s := newTestStore(t)
	last := int64(0)
	for i := 0; i < 20; i++ {
		b := seed(s, "", "url", fmt.Sprintf("bm %d", i), fmt.Sprintf("https://x/%d", i))
		if b.Revision <= last {
			t.Fatalf("revision not monotonic: %d after %d", b.Revision, last)
		}
		last = b.Revision
	}
}

func TestCRUDAndTree(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	_ = seed(s, f.ID, "url", "Go", "https://go.dev")
	kids, err := s.Children(f.ID)
	if err != nil || len(kids) != 1 {
		t.Fatalf("children = %v, %v", kids, err)
	}
	// soft delete folder -> child still rows but subtree returned
	ids, err := s.DeleteSoft(f.ID, Now(), "test")
	if err != nil || len(ids) != 2 {
		t.Fatalf("subtree ids = %v err=%v", ids, err)
	}
	if _, err := s.Children(f.ID); len(kids) != 1 {
		_ = err
	}
	trash, _ := s.Trash()
	if len(trash) != 2 {
		t.Fatalf("trash = %d", len(trash))
	}
	// restore child: parent deleted -> re-attach root
	b, err := s.Restore(kids[0].ID, Now(), "test")
	if err != nil || b.ParentID != "" {
		t.Fatalf("restore: %+v err=%v", b, err)
	}
}

func TestLWWConflict(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "orig", "https://a")

	older := *b
	older.Title = "older"
	older.UpdatedAt = b.UpdatedAt - 10
	older.DeviceID = "aaa"
	got, win, err := s.UpdateLWW(&older, nil)
	if err != nil || win {
		t.Fatalf("older should lose: win=%v err=%v", win, err)
	}
	if got.Title != "orig" {
		t.Fatalf("title changed by losing write: %q", got.Title)
	}

	newer := *b
	newer.Title = "newer"
	newer.UpdatedAt = b.UpdatedAt + 10
	newer.DeviceID = "bbb"
	got, win, err = s.UpdateLWW(&newer, nil)
	if err != nil || !win || got.Title != "newer" {
		t.Fatalf("newer should win: %+v win=%v err=%v", got, win, err)
	}

	// tie (same UpdatedAt as current winner) from a DIFFERENT device:
	// the current row is kept (author clocks are indistinguishable within
	// one second; a genuinely newer edit carries a later second). This also
	// protects snapshot-restored rows from stale same-second tombstones —
	// the old "higher device id wins" rule handed the tie to whichever id
	// sorted higher, letting the web UI's fixed "web" id beat every
	// extension uuid.
	tie := *b
	tie.Title = "tie-b"
	tie.UpdatedAt = b.UpdatedAt + 10
	tie.DeviceID = "zzz"
	got, _, _ = s.UpdateLWW(&tie, nil)
	if got.Title != "newer" {
		t.Fatalf("different-device same-second tie must keep current row: %q", got.Title)
	}
	// same device continuing its edit chain within the same second wins
	tieSameDev := *b
	tieSameDev.Title = "chain-b"
	tieSameDev.UpdatedAt = b.UpdatedAt + 10
	tieSameDev.DeviceID = "bbb"
	got, _, _ = s.UpdateLWW(&tieSameDev, nil)
	if got.Title != "chain-b" {
		t.Fatalf("same-device edit chain must win: %q", got.Title)
	}
}

func TestMoveIntoOwnSubtreeRejected(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "f1", "")
	f2 := seed(s, f1.ID, "folder", "f2", "")
	if _, err := s.Move(f1.ID, f2.ID, 1, Now(), "d"); err == nil {
		t.Fatal("move into own subtree must fail")
	}
	if _, err := s.Move(f2.ID, "", 1, Now(), "d"); err != nil {
		t.Fatalf("normal move failed: %v", err)
	}
}

func TestPurgeKeepsTombstone(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "gone", "https://g")
	if _, err := s.DeleteSoft(b.ID, Now(), "d"); err != nil {
		t.Fatal(err)
	}
	if err := s.Purge(b.ID, Now(), "d"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Purged || got.Title != "" || got.URL != "" || got.DeletedAt == 0 {
		t.Fatalf("purged row wrong: %+v", got)
	}
}

func TestTagsAndSearch(t *testing.T) {
	s := newTestStore(t)
	b1 := seed(s, "", "url", "The Go Programming Language", "https://go.dev/doc")
	b2 := seed(s, "", "url", "Go by Example 中文版", "https://gobyexample-cn.github.io")
	_ = seed(s, "", "url", "Rust book", "https://doc.rust-lang.org")

	if _, err := s.SetTags(b1.ID, []string{"Go Lang", "docs"}, "d"); err != nil {
		t.Fatal(err)
	}
	tags, _ := s.ListTags()
	if len(tags) != 2 || tags[0].Tag != "docs" || tags[0].Count != 1 {
		t.Fatalf("tags = %+v", tags)
	}
	// rename merges: bookmark had [docs, go lang] -> [docs, golang]
	if n, err := s.RenameTag("go lang", "golang"); err != nil || n != 1 {
		t.Fatalf("rename: n=%d err=%v", n, err)
	}
	got, _ := s.Get(b1.ID)
	if len(got.Tags) != 2 || got.Tags[0] != "docs" || got.Tags[1] != "golang" {
		t.Fatalf("merged tags = %v", got.Tags)
	}
	// delete tag removes it everywhere
	if n, err := s.DeleteTag("docs"); err != nil || n != 1 {
		t.Fatalf("delete tag: n=%d err=%v", n, err)
	}
	got, _ = s.Get(b1.ID)
	if len(got.Tags) != 1 || got.Tags[0] != "golang" {
		t.Fatalf("after delete: %v", got.Tags)
	}
	// FTS finds substring/CJK
	res, err := s.Search("中文版", 10)
	if err != nil || len(res) != 1 || res[0].ID != b2.ID {
		t.Fatalf("cjk search = %v err=%v", res, err)
	}
	res, err = s.Search("go.dev", 10)
	if err != nil || len(res) != 1 {
		t.Fatalf("url search = %v err=%v", res, err)
	}
	// short query falls back to LIKE
	res, err = s.Search("Rust", 10)
	if err != nil || len(res) != 1 {
		t.Fatalf("like search = %v err=%v", res, err)
	}
}

func TestChangesSince(t *testing.T) {
	s := newTestStore(t)
	b1 := seed(s, "", "url", "one", "https://1")
	seed(s, "", "url", "two", "https://2")
	changed, maxRev, err := s.ChangesSince(0, 0)
	if err != nil || len(changed) != 2 {
		t.Fatalf("changes = %d err=%v", len(changed), err)
	}
	// modify one
	b1.Title = "one!"
	b1.UpdatedAt += 5
	if _, _, err := s.UpdateLWW(b1, nil); err != nil {
		t.Fatal(err)
	}
	changed, maxRev, _ = s.ChangesSince(0, 0)
	if len(changed) != 2 || maxRev < 3 {
		t.Fatalf("after change: n=%d max=%d", len(changed), maxRev)
	}
	since := changed[0].Revision
	changed2, max2, _ := s.ChangesSince(since, 0)
	if len(changed2) != 1 || max2 != maxRev {
		t.Fatalf("incremental: n=%d max=%d", len(changed2), max2)
	}
}
