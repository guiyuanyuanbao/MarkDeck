package store

import "testing"

// Reorder is a permutation of a parent's children, not a reparenting tool:
// ids from another parent must be rejected instead of silently moved
// (the old implementation wrote parent_id=<parent> for ANY id given).
func TestReorderRejectsForeignIDs(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(&Bookmark{ID: "p1", Type: "folder", Title: "A"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "p2", Type: "folder", Title: "B"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "c1", Type: "url", Title: "in A", URL: "https://a", ParentID: "p1"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "c2", Type: "url", Title: "in B", URL: "https://b", ParentID: "p2"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Reorder("p1", []string{"c2", "c1"}, Now(), "t"); err == nil {
		t.Fatal("foreign id must be rejected")
	}
	b1, _ := s.Get("c1")
	b2, _ := s.Get("c2")
	if b1.ParentID != "p1" || b2.ParentID != "p2" {
		t.Fatalf("parents must be untouched: c1=%q c2=%q", b1.ParentID, b2.ParentID)
	}
	// a legitimate permutation still works
	if err := s.Reorder("p1", []string{"c1"}, Now(), "t"); err != nil {
		t.Fatalf("own-child reorder failed: %v", err)
	}
	// deleted ids are rejected too (reordering trash is meaningless)
	if _, err := s.DeleteSoft("c1", Now(), "t"); err != nil {
		t.Fatal(err)
	}
	if err := s.Reorder("p1", []string{"c1"}, Now(), "t"); err == nil {
		t.Fatal("deleted id must be rejected")
	}
}
