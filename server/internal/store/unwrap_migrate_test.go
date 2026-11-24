package store

import (
	"path/filepath"
	"testing"
)

// The user-visible bug: importing a Chrome Netscape export (pre-unwrap
// importer) created a phantom top-level "Bookmarks bar" wrapper folder.
// The migration must lift its folder children to top level, hard-delete
// the shell, and leave genuinely-named user folders holding direct urls
// untouched.
func TestUnwrapBookmarksBarWrappers(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// simulate the old importer's residue: wrapper "Bookmarks bar" holding
	// two folders, plus a real user folder named 书签栏 holding a direct url
	wrapper := &Bookmark{ID: "wrap1", ParentID: "", Type: "folder", Title: "Bookmarks bar", DeviceID: "import", UpdatedAt: 1, CreatedAt: 1}
	if _, err := s.Create(wrapper, nil); err != nil {
		t.Fatal(err)
	}
	f1 := &Bookmark{ID: "wf1", ParentID: "wrap1", Type: "folder", Title: "北邮", DeviceID: "import", UpdatedAt: 1, CreatedAt: 1}
	f2 := &Bookmark{ID: "wf2", ParentID: "wrap1", Type: "folder", Title: "编程", DeviceID: "import", UpdatedAt: 1, CreatedAt: 1}
	for _, f := range []*Bookmark{f1, f2} {
		if _, err := s.Create(f, nil); err != nil {
			t.Fatal(err)
		}
	}
	realUser := &Bookmark{ID: "real1", ParentID: "", Type: "folder", Title: "书签栏", DeviceID: "user", UpdatedAt: 1, CreatedAt: 1}
	if _, err := s.Create(realUser, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "ru1", ParentID: "real1", Type: "url", Title: "真实书签", URL: "https://real.test", DeviceID: "user", UpdatedAt: 1, CreatedAt: 1}, nil); err != nil {
		t.Fatal(err)
	}

	if err := s.unwrapBookmarksBarWrappers(); err != nil {
		t.Fatalf("unwrap: %v", err)
	}

	// wrapper shell gone
	if _, err := s.Get("wrap1"); err != ErrNotFound {
		t.Fatalf("wrapper shell must be hard-deleted: %v", err)
	}
	// its folder children lifted to top level
	f1n, _ := s.Get("wf1")
	f2n, _ := s.Get("wf2")
	if f1n.ParentID != "" || f2n.ParentID != "" {
		t.Fatalf("children must lift to top level: %s / %s", f1n.ParentID, f2n.ParentID)
	}
	// the real user folder (holds direct urls) untouched
	ru, _ := s.Get("ru1")
	if ru.ParentID != "real1" {
		t.Fatalf("genuinely-named user folder must survive: %+v", ru)
	}
	// re-running is a no-op
	if err := s.unwrapBookmarksBarWrappers(); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if _, err := s.Get("real1"); err != nil {
		t.Fatalf("real folder vanished on second run: %v", err)
	}
}
