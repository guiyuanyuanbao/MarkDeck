package store

import (
	"testing"
)

// RestoreFromDump bulk-DELETEs bookmarks outside triggers, then rebuilds FTS
// manually. If the rebuild misses rows, search silently loses them.
func TestSearchAfterRestore(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create(&Bookmark{ID: "f1", Type: "folder", Title: "根"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(&Bookmark{ID: "u1", Type: "url", Title: "独特搜索词XYZZY", URL: "https://x", ParentID: "f1"}, nil); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.Tree()
	dump := make([]*Bookmark, 0)
	for _, r := range rows {
		cp := *r
		dump = append(dump, &cp)
	}
	if err := s.RestoreFromDump(dump, "t"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Search("XYZZY", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("search after restore found %d rows, want 1 (FTS rebuild gap)", len(got))
	}
}
