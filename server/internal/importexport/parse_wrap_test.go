package importexport

import (
	"path/filepath"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Chrome/Edge Netscape exports wrap everything in one outer <DL> and emit
// "Bookmarks bar" / "Other bookmarks" as H3 folders inside it. The parser
// must NOT surface those two wrappers as importable top-level folders —
// their CONTENT belongs at top level (or under the bar), and importing the
// wrapper verbatim produces the user-visible "extra Bookmarks bar layer".
func TestParseChromeExportDoesNotWrap(t *testing.T) {
	sample := `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1730000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/bar">Bar Site</A>
    </DL><p>
    <DT><H3 ADD_DATE="1730000000">Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://example.com/other">Other Site</A>
    </DL><p>
</DL><p>`
	root, err := ParseNetscapeHTML([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range root.Children {
		// "Bookmarks bar" must never survive; the synthetic 其他书签 node IS
		// allowed but must be flagged so Import routes it into the canonical
		// holder (a plain same-named folder would bind as a duplicate shell)
		if c.Title == "Bookmarks bar" || c.Title == "书签栏" || c.Title == "Other bookmarks" {
			t.Fatalf("parser surfaced browser-root wrapper %q as a top-level folder — importing it creates the extra layer", c.Title)
		}
		if c.Title == "其他书签" && !c.isOtherHolder {
			t.Fatalf("其他书签 wrapper survived without the isOtherHolder routing flag")
		}
	}
	var urls []string
	var walk func(n *Node)
	walk = func(n *Node) {
		if n.URL != "" {
			urls = append(urls, n.URL)
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	if len(urls) != 2 {
		t.Fatalf("expected both urls reachable, got %v", urls)
	}
}

// End-to-end through Import merge: bar content lands top-level, other-
// bookmarks content lands under the canonical md-others holder, and NO
// "Bookmarks bar" wrapper folder is created anywhere.
func TestImportChromeExportNoWrapperLayer(t *testing.T) {
	sample := `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1730000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/bar">Bar Site</A>
        <DT><A HREF="https://example.com/other">Shared Site</A>
    </DL><p>
    <DT><H3 ADD_DATE="1730000000">Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://example.com/other2">Other Site</A>
    </DL><p>
</DL><p>`
	root, err := ParseNetscapeHTML([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	res, err := Import(st, root, ImportOptions{Mode: "merge", DeviceID: "import"})
	if err != nil {
		t.Fatal(err)
	}
	nodes, _ := st.Tree()
	for _, n := range nodes {
		if n.Title == "Bookmarks bar" || n.Title == "Other bookmarks" {
			t.Fatalf("wrapper folder %q imported into the tree", n.Title)
		}
	}
	var barSite, otherSite bool
	for _, n := range nodes {
		if n.Type == "url" && n.URL == "https://example.com/bar" && n.ParentID == "" {
			barSite = true
		}
		if n.Type == "url" && n.URL == "https://example.com/other2" && n.ParentID == store.CanonicalOthersID() {
			otherSite = true
		}
	}
	if !barSite {
		t.Fatalf("bar content must land top-level, nodes=%+v", nodes)
	}
	if !otherSite {
		t.Fatalf("other-bookmarks content must land under the canonical holder")
	}
	if res.Created != 3 {
		t.Fatalf("created=%d want 3", res.Created)
	}
}

// ICON attributes in Chrome exports carry each bookmark's REAL favicon as a
// data: URI — the correct source for admin-UI icons. Import must harvest
// them into the favicons table per host.
func TestImportHarvestsIconsFromExport(t *testing.T) {
	// 1x1 red PNG
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	const ghPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
	sample := `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://mail.google.com/" ICON="data:image/png;base64,` + png + `">Gmail</A>
        <DT><A HREF="https://github.com/" ICON="data:image/png;base64,` + ghPng + `">GitHub</A>
        <DT><A HREF="https://no-icon.test/">No Icon</A>
    </DL><p>
</DL><p>`
	root, err := ParseNetscapeHTML([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := Import(st, root, ImportOptions{Mode: "merge", DeviceID: "import"}); err != nil {
		t.Fatal(err)
	}
	// Gmail icon stored under its host
	row, err := st.FaviconGet("mail.google.com")
	if err != nil || len(row.Data) == 0 {
		t.Fatalf("Gmail icon not harvested: %v", err)
	}
	if row.ContentType != "image/png" {
		t.Fatalf("content type = %s", row.ContentType)
	}
	row2, err := st.FaviconGet("github.com")
	if err != nil || len(row2.Data) == 0 {
		t.Fatalf("GitHub icon not harvested")
	}
	if string(row.Data) == string(row2.Data) {
		t.Fatal("per-host icons must differ")
	}
	// no-icon host must NOT appear
	if _, err := st.FaviconGet("no-icon.test"); err == nil {
		t.Fatal("host without ICON must not have an entry")
	}
}
