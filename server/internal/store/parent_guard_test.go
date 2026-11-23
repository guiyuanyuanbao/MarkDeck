package store

import "testing"

// REST creates must reject nonexistent/deleted parents — the old code
// silently INSERTed orphaned rows that appeared in no tree view but
// synced to devices as unplaceable rows.
func TestCreateRejectsBadParents(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(&Bookmark{ID: "p", Type: "folder", Title: "P"}, nil); err != nil {
		t.Fatal(err)
	}
	// nonexistent parent
	if _, err := s.Create(&Bookmark{ID: "c1", Type: "url", Title: "x", URL: "https://x", ParentID: "ghost"}, nil); err == nil {
		t.Fatal("ghost parent must be rejected")
	}
	// deleted parent
	if _, err := s.Create(&Bookmark{ID: "c2", Type: "url", Title: "y", URL: "https://y", ParentID: "p"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteSoft("p", Now(), "t"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "c3", Type: "url", Title: "z", URL: "https://z", ParentID: "p"}, nil); err == nil {
		t.Fatal("trashed parent must be rejected")
	}
	// sync path opt-out still works
	if _, err := s.Create(&Bookmark{ID: "c4", Type: "url", Title: "w", URL: "https://w", ParentID: "ghost", SkipParentCheck: true}, nil); err != nil {
		t.Fatalf("SkipParentCheck must allow batch inserts: %v", err)
	}
	// url without url rejected
	if _, err := s.Create(&Bookmark{ID: "c5", Type: "url", Title: "nourl"}, nil); err == nil {
		t.Fatal("url bookmark without URL must be rejected")
	}
}

// Moving into a trashed folder re-parents the node into the void.
func TestMoveIntoTrashedParentRejected(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(&Bookmark{ID: "src", Type: "folder", Title: "S"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "dst", Type: "folder", Title: "D"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "n", Type: "url", Title: "N", URL: "https://n", ParentID: "src"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteSoft("dst", Now(), "t"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Move("n", "dst", 1, Now(), "t"); err == nil {
		t.Fatal("move into trashed folder must be rejected")
	}
	n, _ := s.Get("n")
	if n.ParentID != "src" {
		t.Fatalf("node must stay in src, got %q", n.ParentID)
	}
}
