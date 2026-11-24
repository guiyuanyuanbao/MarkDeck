package tools

import (
	"path/filepath"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

func newTestChain(t *testing.T) *Chain {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	return NewChain(st, filepath.Join(t.TempDir(), "snaps"), nil)
}

func TestFolderDuplicatesScanAndMerge(t *testing.T) {
	c := newTestChain(t)
	// two same-named folders under root, each with children (one dup url)
	if _, err := c.Store.Create(&store.Bookmark{ID: "a", Type: "folder", Title: "北邮"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Store.Create(&store.Bookmark{ID: "b", Type: "folder", Title: "北邮"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Store.Create(&store.Bookmark{ID: "a1", Type: "url", Title: "Overleaf", URL: "https://overleaf.com/project", ParentID: "a"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Store.Create(&store.Bookmark{ID: "b1", Type: "url", Title: "Overleaf", URL: "https://overleaf.com/project", ParentID: "b"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Store.Create(&store.Bookmark{ID: "b2", Type: "url", Title: "Unique", URL: "https://unique.test", ParentID: "b"}, nil); err != nil {
		t.Fatal("b2:", err)
	}
	groups, err := c.FindFolderDuplicates()
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].Title != "北邮" || len(groups[0].Items) != 2 {
		t.Fatalf("scan wrong: %+v", groups)
	}
	moved, err := c.MergeFolderDuplicates("a", []string{"b"})
	if err != nil {
		t.Fatal(err)
	}
	if kb, _ := c.Store.Children("b"); len(kb) > 0 {
		for _, k := range kb {
			t.Logf("still-in-b: %s title=%q", k.ID, k.Title)
		}
	}
	if moved != 1 { // b2 moves; b1 is a dup of a1 → dropped
		t.Fatalf("moved=%d, want 1 (unique child only)", moved)
	}
	// both children now under a (minus the dup)
	n2, _ := c.Store.Get("b2")
	t.Logf("b2 after merge: parent=%q deleted=%d", n2.ParentID, n2.DeletedAt)
	kids, _ := c.Store.Children("a")
	if len(kids) != 2 {
		t.Fatalf("target children=%d, want 2", len(kids))
	}
	// shell b is trashed
	bNode, _ := c.Store.Get("b")
	if bNode.DeletedAt == 0 {
		t.Fatal("shell b must be trashed after merge")
	}
	// unique child survived under a
	n, _ := c.Store.Get("b2")
	if n.DeletedAt > 0 || n.ParentID != "a" {
		t.Fatalf("unique child must survive under a: %+v", n)
	}
}
