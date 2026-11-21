package importexport

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Fixture mirrors the shape Chrome/Edge export (unclosed DT, nested DL).
const fixture = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001">开发资源</H3>
    <DL><p>
        <DT><A HREF="https://go.dev" ADD_DATE="1700000002">Go 官网</A>
        <DT><A HREF="https://github.com/?utm_source= Newsletter" ADD_DATE="1700000003">GitHub</A>
        <DT><H3 ADD_DATE="1700000004">子目录</H3>
        <DL><p>
            <DT><A HREF="https://protobuf.dev" ADD_DATE="1700000005">Protobuf</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com" ADD_DATE="1700000006">Hacker News</A>
</DL><p>`

func TestParseFixture(t *testing.T) {
	root, err := ParseNetscapeHTML([]byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	if len(root.Children) != 2 {
		t.Fatalf("root children = %d, want 2 (folder + flat link)", len(root.Children))
	}
	folder := root.Children[0]
	if folder.Title != "开发资源" || len(folder.Children) != 3 {
		t.Fatalf("folder = %+v", folder)
	}
	go1 := folder.Children[0]
	if go1.URL != "https://go.dev" || go1.Title != "Go 官网" {
		t.Fatalf("go link = %+v", go1)
	}
	sub := folder.Children[2]
	if len(sub.Children) != 1 || sub.Children[0].Title != "Protobuf" {
		t.Fatalf("subfolder = %+v", sub)
	}
	if folder.AddDate != 1700000000 {
		t.Fatalf("add_date lost: %d", folder.AddDate)
	}
}

func TestImportNewFolderMode(t *testing.T) {
	s := newStore(t)
	root, _ := ParseNetscapeHTML([]byte(fixture))
	res, err := Import(s, root, ImportOptions{Mode: "newfolder", RootName: "导入的书签", DeviceID: "web"})
	if err != nil {
		t.Fatal(err)
	}
	// 4 urls + 3 folders (root + 2 subfolders)
	if res.Created != 7 || len(res.Errors) > 0 {
		t.Fatalf("result = %+v", res)
	}
	nodes, _ := s.Tree()
	var titles []string
	for _, n := range nodes {
		titles = append(titles, n.Title)
	}
	joined := strings.Join(titles, ",")
	if !strings.Contains(joined, "导入的书签") || !strings.Contains(joined, "Go 官网") {
		t.Fatalf("titles = %v", titles)
	}
}

func TestImportMergeDedupesURLs(t *testing.T) {
	s := newStore(t)
	root, _ := ParseNetscapeHTML([]byte(fixture))
	// first import
	if _, err := Import(s, root, ImportOptions{Mode: "merge", DeviceID: "web"}); err != nil {
		t.Fatal(err)
	}
	before, _ := s.Tree()
	nBefore := len(before)
	// second import: all URLs already exist -> only folders created, 4 dupes
	res, err := Import(s, root, ImportOptions{Mode: "merge", DeviceID: "web"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Duplicates != 4 {
		t.Fatalf("duplicates = %d, want 4", res.Duplicates)
	}
	after, _ := s.Tree()
	// folders get re-created (no folder-level dedupe) but no new URL rows
	urls := 0
	for _, n := range after {
		if n.Type == "url" {
			urls++
		}
	}
	if urls != 4 {
		t.Fatalf("url rows = %d, want 4", urls)
	}
	if nBefore < 4 {
		t.Fatalf("sanity")
	}
}

func TestNormURL(t *testing.T) {
	cases := map[string]string{
		"https://www.Example.com/":                 "https://example.com",
		"http://example.com/a?utm_source=x&keep=1": "http://example.com/a?keep=1",
		"https://example.com/path/?fbclid=ABC":     "https://example.com/path/",
		"https://example.com/path#sec?utm_term=z":  "https://example.com/path#sec",
		"HTTPS://News.YCombinator.COM/item?id=1":   "https://news.ycombinator.com/item?id=1",
	}
	for in, want := range cases {
		if got := normURL(in); got != want {
			t.Errorf("normURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExportRoundtrip(t *testing.T) {
	s := newStore(t)
	root, _ := ParseNetscapeHTML([]byte(fixture))
	if _, err := Import(s, root, ImportOptions{Mode: "newfolder", RootName: "R", DeviceID: "web"}); err != nil {
		t.Fatal(err)
	}
	nodes, _ := s.Tree()
	out, err := ExportNetscapeHTML(nodes)
	if err != nil {
		t.Fatal(err)
	}
	htmlStr := string(out)
	if !strings.Contains(htmlStr, "Go 官网") || !strings.Contains(htmlStr, `HREF="https://go.dev"`) {
		t.Fatalf("export missing content:\n%s", htmlStr)
	}
	// exported file parses back with same link count
	root2, err := ParseNetscapeHTML(out)
	if err != nil {
		t.Fatal(err)
	}
	total := countURLs(root2)
	if total != 4 {
		t.Fatalf("roundtrip urls = %d, want 4", total)
	}
	_ = filepath.Join // keep import if unused later
}

func countURLs(n *Node) int {
	c := 0
	if n.URL != "" {
		c++
	}
	for _, ch := range n.Children {
		c += countURLs(ch)
	}
	return c
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}
