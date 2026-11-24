package importexport

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Double-import regression on a REAL Chrome export (local-only fixture,
// never committed): re-running the same merge import must not grow empty
// same-named folder shells, and every url in the file must be reachable
// exactly once after both runs. Skips when the fixture is absent.
func TestDoubleImportMergeNoGhostFolders(t *testing.T) {
	fixture := os.Getenv("MARKDECK_REAL_EXPORT")
	if fixture == "" {
		t.Skip("MARKDECK_REAL_EXPORT not set (local fixture only)")
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	root, err := ParseNetscapeHTML(data)
	if err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	res1, err := Import(st, root, ImportOptions{Mode: "merge", DeviceID: "import"})
	if err != nil {
		t.Fatal(err)
	}
	res2, err := Import(st, root, ImportOptions{Mode: "merge", DeviceID: "import"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("run1: created=%d dup=%d errors=%v", res1.Created, res1.Duplicates, res1.Errors)
	t.Logf("run2: created=%d dup=%d errors=%v", res2.Created, res2.Duplicates, res2.Errors)

	// every top-level title must appear exactly ONCE (no ghost shells)
	nodes, _ := st.Tree()
	titleCount := map[string]int{}
	for _, n := range nodes {
		if n.Type == "folder" && n.ParentID == "" {
			titleCount[n.Title]++
		}
	}
	for t2, c := range titleCount {
		if c > 1 {
			t.Fatalf("top-level folder %q appears %d times after double import (ghost shells)", t2, c)
		}
	}

	// every url in the export must be present exactly once
	count := 0
	for _, n := range nodes {
		if n.Type == "url" {
			count++
		}
	}
	// expected: unique urls in the export (parse independently)
	urlSet := map[string]bool{}
	for _, n := range root.Children {
		var walk func(x *Node)
		walk = func(x *Node) {
			if x.URL != "" {
				urlSet[normURL(x.URL)] = true
			}
			for _, c := range x.Children {
				walk(c)
			}
		}
		walk(n)
	}
	if count != len(urlSet) {
		t.Fatalf("tree holds %d url rows, export has %d unique urls — import lost or duplicated rows", count, len(urlSet))
	}
	// second run must create nothing (pure dedupe)
	if res2.Created != 0 {
		t.Fatalf("second import created %d rows (should be 0)", res2.Created)
	}
}
