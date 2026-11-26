// Package importexport converts between MarkDeck bookmarks and the
// Netscape bookmark HTML format used by every major browser.
package importexport

import (
	"encoding/base64"
	"fmt"
	html "golang.org/x/net/html"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Node is one parsed entry: a folder or a URL.
type Node struct {
	Title    string
	URL      string
	AddDate  int64  // unix seconds
	IconData []byte // decoded ICON="data:image/...;base64,..." attribute (may be nil)
	Children []*Node
	// toolbarFolderAttr: the H3 carried PERSONAL_TOOLBAR_FOLDER="true" —
	// Chromium's locale-independent marker for "this is my bookmarks bar".
	// Title strings are localized and matchable only as a fallback.
	toolbarFolderAttr bool
	// isOtherHolder: synthetic folder from unwrapBrowserRoots carrying
	// other-bookmarks content; Import routes it into the canonical holder.
	isOtherHolder bool
}

// ParseNetscapeHTML parses a bookmark export file into a synthetic root.
// Tolerates the messy real-world markup browsers emit (unclosed <DT>,
// <p> interludes, nested DLs).
func ParseNetscapeHTML(data []byte) (*Node, error) {
	root := &Node{Title: "root"}
	stack := []*Node{root}
	var pendingH3 string
	var pendingAdd int64
	var h3Toolbar bool

	tk := html.NewTokenizer(strings.NewReader(string(data)))
	depthDL := 0
	for {
		tt := tk.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			t := tk.Token()
			switch t.Data {
			case "dl":
				depthDL++
			case "h3":
				pendingH3 = ""
				pendingAdd = 0
				pendingToolbar := false
				for _, a := range t.Attr {
					switch a.Key {
					case "add_date":
						pendingAdd = parseTime(a.Val)
					case "personal_toolbar_folder":
						pendingToolbar = strings.EqualFold(a.Val, "true")
					}
				}
				h3Toolbar = pendingToolbar
			case "a":
				var title, url string
				var add int64
				var iconData []byte
				for _, a := range t.Attr {
					switch a.Key {
					case "href":
						url = a.Val
					case "add_date":
						add = parseTime(a.Val)
					case "icon":
						iconData = decodeDataURI(a.Val)
					}
				}
				// text follows in next TextToken
				n := &Node{URL: url, AddDate: add, IconData: iconData}
				if txt := nextText(tk); txt != "" {
					title = txt
				}
				n.Title = title
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, n)
			}
		case html.EndTagToken:
			t := tk.Token()
			switch t.Data {
			case "dl":
				depthDL--
				if len(stack) > 1 && depthDL >= 0 {
					stack = stack[:len(stack)-1]
				}
			case "h3":
				if len(stack) > 0 {
					f := &Node{Title: firstNonEmpty(pendingH3, ""), AddDate: pendingAdd, toolbarFolderAttr: h3Toolbar}
					h3Toolbar = false
					// folder node: attach to current parent, push as new context
					parent := stack[len(stack)-1]
					parent.Children = append(parent.Children, f)
					stack = append(stack, f)
				}
			}
		case html.TextToken:
			// h3 text arrives here before </h3>; stash it. Parser-local (was a
			// package global — concurrent imports raced on it).
			trimmed := strings.TrimSpace(tk.Token().Data)
			if trimmed != "" && pendingH3 == "" {
				// only meaningful inside h3; nextText path covers <a> text
				pendingH3 = trimmed
			}
		}
	}
	unwrapBrowserRoots(root)
	return root, nil
}

// ensureCanonicalHolder returns the id of the canonical 其他书签 folder,
// creating it (top level, tail position) when absent. Mirrors the store's
// migration row shape so the reconciler's structural binding picks it up.
func ensureCanonicalHolder(s *store.Store, at int64) (string, error) {
	if existing, err := s.Get(store.CanonicalOthersID()); err == nil {
		return existing.ID, nil
	}
	created, err := s.Create(&store.Bookmark{
		ID: store.CanonicalOthersID(), ParentID: "", Type: "folder",
		Title: "其他书签", Position: 9999,
		UpdatedAt: at, DeviceID: "import", CreatedAt: at,
	}, nil)
	if err != nil {
		return "", err
	}
	return created.ID, nil
}

// unwrapBrowserRoots removes the browser-root wrapper folders a Netscape
// export always contains: Chrome/Edge emit "Bookmarks bar" (with
// PERSONAL_TOOLBAR_FOLDER="true") and "Other bookmarks" as H3 folders
// inside the single outer <DL>. Importing those wrappers verbatim created
// a phantom extra "Bookmarks bar" layer in the server tree that then
// mirrored to every browser. Their CHILDREN are the real content: bar
// children lift to top level, other-bookmarks children move under the
// canonical 其他书签 holder. Only unwraps when the wrapper is a folder with
// a browser-root name (localized titles included) — a user folder that
// happens to be named 书签栏 is only unwrapped when it carries the
// PERSONAL_TOOLBAR_FOLDER attribute, never on title alone.
func unwrapBrowserRoots(root *Node) {
	var barKids, otherKids []*Node
	kept := root.Children[:0]
	for _, c := range root.Children {
		switch {
		case c.URL == "" && isBrowserBarWrapper(c):
			barKids = append(barKids, c.Children...)
		case c.URL == "" && isBrowserOtherWrapper(c):
			otherKids = append(otherKids, c.Children...)
		default:
			kept = append(kept, c)
		}
	}
	root.Children = append(kept, barKids...)
	if len(otherKids) > 0 {
		// other-bookmarks content is exported back as a synthetic folder
		// node named exactly 其他书签; Import routes folders with this
		// reserved name into the canonical holder instead of re-creating a
		// same-named sibling (which the engine would then bind to the
		// holder anyway — routing here keeps the import result honest).
		root.Children = append(root.Children, &Node{Title: otherHolderReservedName, Children: otherKids, isOtherHolder: true})
	}
}

// otherHolderReservedName marks the synthetic folder that carries
// other-bookmarks content out of unwrapBrowserRoots.
const otherHolderReservedName = "其他书签"

// browser-root wrapper names across locales (title match restricted to the
// two known Chromium root names in the user's locales; attribute match is
// locale-independent and always trusted)
func isBrowserBarWrapper(n *Node) bool {
	for _, a := range []string{n.Title} {
		switch a {
		case "Bookmarks bar", "书签栏", "Bookmarks Bar", "书签工具栏":
			return true
		}
	}
	return n.toolbarFolderAttr
}

func isBrowserOtherWrapper(n *Node) bool {
	switch n.Title {
	case "Other bookmarks", "其他书签", "Mobile bookmarks", "移动设备书签":
		return true
	}
	return false
}

func nextText(tk *html.Tokenizer) string {
	for {
		tt := tk.Next()
		switch tt {
		case html.TextToken:
			return strings.TrimSpace(tk.Token().Data)
		case html.EndTagToken:
			return ""
		case html.ErrorToken:
			return ""
		}
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func parseTime(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return n
		}
		n = n*10 + int64(s[i]-'0')
	}
	// Chrome emits seconds; some tools emit milliseconds.
	if n > 1e12 {
		n /= 1000
	}
	return n
}

// ImportOptions controls how a parsed tree lands in the database.
type ImportOptions struct {
	Mode     string // "newfolder" | "merge"
	RootName string // used in newfolder mode
	DeviceID string
}

// ImportResult reports counts and dedupe outcomes.
type ImportResult struct {
	Created    int      `json:"created"`
	Duplicates int      `json:"duplicates"`
	RootID     string   `json:"rootId"`
	Errors     []string `json:"errors,omitempty"`
}

// Import inserts the parsed tree. In "newfolder" mode everything goes under
// one folder; in "merge" mode top-level folders are matched by title against
// existing roots and URLs already present are skipped.
func Import(s *store.Store, root *Node, opts ImportOptions) (*ImportResult, error) {
	res := &ImportResult{}
	at := store.Now()

	// favicon harvesting: Chrome exports embed each bookmark's real icon as
	// a data: URI — far more accurate than fetching. Collect per-host (first
	// non-empty wins) and store after a successful import.
	iconsByHost := map[string][]byte{}
	var harvestIcons func(n *Node)
	harvestIcons = func(n *Node) {
		if n.IconData != nil && n.URL != "" {
			if h := hostOfURL(n.URL); h != "" && iconsByHost[h] == nil {
				iconsByHost[h] = n.IconData
			}
		}
		for _, c := range n.Children {
			harvestIcons(c)
		}
	}
	harvestIcons(root)

	var existingURLs map[string]bool
	if opts.Mode == "merge" {
		existingURLs = map[string]bool{}
		nodes, err := s.Tree()
		if err != nil {
			return nil, err
		}
		for _, n := range nodes {
			if n.Type == "url" {
				existingURLs[normURL(n.URL)] = true
			}
		}
	}

	// findExistingFolder: same-title live folder under the same parent —
	// re-running an import must MERGE into the existing tree, not grow
	// empty same-named shells every run.
	var findExistingFolder = func(parentID, title string) (string, bool) {
		kids, err := s.Children(parentID)
		if err != nil {
			return "", false
		}
		for _, k := range kids {
			if k.Type == "folder" && k.Title == title {
				return k.ID, true
			}
		}
		return "", false
	}
	var importFolder func(parentID string, n *Node, depth int) (string, error)
	importFolder = func(parentID string, n *Node, depth int) (string, error) {
		// merge mode reuses an existing same-named folder under the same
		// parent (dedupe by URL still applies to its children); newfolder
		// mode always creates the fresh wrapper folder
		if opts.Mode == "merge" {
			if existing, ok := findExistingFolder(parentID, firstNonEmpty(n.Title, "imported")); ok {
				for _, c := range n.Children {
					if c.URL == "" { // folder
						if _, err := importFolder(existing, c, depth+1); err != nil {
							res.Errors = append(res.Errors, err.Error())
						}
						continue
					}
					if existingURLs != nil {
						if existingURLs[normURL(c.URL)] {
							res.Duplicates++
							continue
						}
						existingURLs[normURL(c.URL)] = true
					}
					b := &store.Bookmark{
						ParentID: existing, Type: "url", Title: c.Title, URL: c.URL,
						UpdatedAt: at, DeviceID: opts.DeviceID, CreatedAt: at,
					}
					if _, err := s.Create(b, nil); err != nil {
						res.Errors = append(res.Errors, err.Error())
					} else {
						res.Created++
					}
				}
				return existing, nil
			}
		}
		f := &store.Bookmark{
			ParentID: parentID, Type: "folder", Title: firstNonEmpty(n.Title, "imported"),
			UpdatedAt: at, DeviceID: opts.DeviceID, CreatedAt: at,
		}
		created, err := s.Create(f, nil)
		if err != nil {
			return "", err
		}
		res.Created++
		for _, c := range n.Children {
			if c.URL == "" { // folder
				if _, err := importFolder(created.ID, c, depth+1); err != nil {
					res.Errors = append(res.Errors, err.Error())
				}
				continue
			}
			if existingURLs != nil {
				if existingURLs[normURL(c.URL)] {
					res.Duplicates++
					continue
				}
				existingURLs[normURL(c.URL)] = true
			}
			b := &store.Bookmark{
				ParentID: created.ID, Type: "url", Title: c.Title, URL: c.URL,
				UpdatedAt: at, DeviceID: opts.DeviceID, CreatedAt: at,
			}
			if _, err := s.Create(b, nil); err != nil {
				res.Errors = append(res.Errors, err.Error())
			} else {
				res.Created++
			}
		}
		return created.ID, nil
	}

	if opts.Mode == "merge" {
		// Import each top-level child into root (dedup by URL across the batch).
		for _, c := range root.Children {
			if c.URL == "" {
				// the synthetic other-bookmarks holder routes into the
				// canonical md-others folder (create if absent) — never as
				// a same-named sibling the engine would then have to adopt
				if c.isOtherHolder {
					holderID, err := ensureCanonicalHolder(s, at)
					if err != nil {
						res.Errors = append(res.Errors, err.Error())
						continue
					}
					for _, k := range c.Children {
						if k.URL == "" {
							if _, err := importFolder(holderID, k, 0); err != nil {
								res.Errors = append(res.Errors, err.Error())
							}
							continue
						}
						if existingURLs[normURL(k.URL)] {
							res.Duplicates++
							continue
						}
						existingURLs[normURL(k.URL)] = true
						b := &store.Bookmark{
							ParentID: holderID, Type: "url", Title: k.Title, URL: k.URL,
							UpdatedAt: at, DeviceID: opts.DeviceID, CreatedAt: at,
						}
						if _, err := s.Create(b, nil); err != nil {
							res.Errors = append(res.Errors, err.Error())
						} else {
							res.Created++
						}
					}
					continue
				}
				if _, err := importFolder("", c, 0); err != nil {
					res.Errors = append(res.Errors, err.Error())
				}
				continue
			}
			if existingURLs[normURL(c.URL)] {
				res.Duplicates++
				continue
			}
			existingURLs[normURL(c.URL)] = true
			b := &store.Bookmark{
				ParentID: "", Type: "url", Title: c.Title, URL: c.URL,
				UpdatedAt: at, DeviceID: opts.DeviceID, CreatedAt: at,
			}
			if _, err := s.Create(b, nil); err != nil {
				res.Errors = append(res.Errors, err.Error())
			} else {
				res.Created++
			}
		}
		storeIcons(s, iconsByHost)
		return res, nil
	}

	// newfolder mode
	r := &Node{Title: firstNonEmpty(opts.RootName, "Imported "+time.Now().Format("2006-01-02")), Children: root.Children}
	rid, err := importFolder("", r, 0)
	if err != nil {
		return nil, err
	}
	res.RootID = rid
	storeIcons(s, iconsByHost)
	return res, nil
}

// hostOfURL extracts the hostname for favicon keying ("" on parse failure).
func hostOfURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Hostname()
}

// storeIcons writes harvested icons into the favicon cache. These are the
// browser's own icons — they outrank any cached fetch, so write unconditionally.
func storeIcons(s *store.Store, icons map[string][]byte) {
	for host, data := range icons {
		ctype := "image/png"
		if len(data) >= 3 && data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 {
			ctype = "image/gif"
		} else if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
			ctype = "image/jpeg"
		} else if len(data) >= 4 && data[0] == '<' && data[1] == 's' && data[2] == 'v' {
			ctype = "image/svg+xml"
		}
		_ = s.FaviconPut(host, ctype, data)
	}
}

// ExportNetscapeHTML renders the live tree as Netscape bookmark HTML.
func ExportNetscapeHTML(nodes []*store.Bookmark) ([]byte, error) {
	byParent := map[string][]*store.Bookmark{}
	for _, n := range nodes {
		byParent[n.ParentID] = append(byParent[n.ParentID], n)
	}
	// stable order by position
	for _, kids := range byParent {
		sort.Slice(kids, func(i, j int) bool { return kids[i].Position < kids[j].Position })
	}

	var b strings.Builder
	b.WriteString(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>MarkDeck Bookmarks</TITLE>
<H1>MarkDeck Bookmarks</H1>
<DL><p>
`)
	var walk func(parentID string, depth int)
	walk = func(parentID string, depth int) {
		indent := strings.Repeat("    ", depth+1)
		for _, n := range byParent[parentID] {
			if n.Type == "folder" {
				fmt.Fprintf(&b, "%s<DT><H3 ADD_DATE=\"%d\">%s</H3>\n%s<DL><p>\n",
					indent, n.CreatedAt, esc(n.Title), indent)
				walk(n.ID, depth+1)
				fmt.Fprintf(&b, "%s</DL><p>\n", indent)
			} else {
				fmt.Fprintf(&b, "%s<DT><A HREF=\"%s\" ADD_DATE=\"%d\">%s</A>\n",
					indent, esc(n.URL), n.CreatedAt, esc(n.Title))
			}
		}
	}
	walk("", 0)
	b.WriteString("</DL><p>\n")
	return []byte(b.String()), nil
}

func esc(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	return s
}

// normURL canonicalizes for duplicate detection: strips tracking params,
// lowercases scheme+host, drops trailing slash on empty path.
func normURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	i := strings.Index(raw, "://")
	scheme, rest := "", raw
	if i > 0 {
		scheme = strings.ToLower(raw[:i+3])
		rest = raw[i+3:]
	}
	host := rest
	path := "/"
	if j := strings.IndexAny(rest, "/?#"); j >= 0 {
		host = rest[:j]
		path = rest[j:]
	}
	host = strings.ToLower(host)
	host = strings.TrimPrefix(host, "www.")
	// strip common tracking params from query
	if q := strings.Index(path, "?"); q >= 0 {
		query := path[q+1:]
		frag := ""
		if f := strings.Index(query, "#"); f >= 0 {
			frag = query[f:]
			query = query[:f]
		}
		var keep []string
		for _, kv := range strings.Split(query, "&") {
			k := strings.ToLower(kv)
			if idx := strings.Index(k, "="); idx >= 0 {
				k = k[:idx]
			}
			if trackingParams[k] {
				continue
			}
			keep = append(keep, kv)
		}
		path = path[:q]
		if len(keep) > 0 {
			path += "?" + strings.Join(keep, "&")
		}
		path += frag
	}
	if path == "/" {
		path = ""
	}
	return scheme + host + path
}

var trackingParams = map[string]bool{
	"utm_source": true, "utm_medium": true, "utm_campaign": true,
	"utm_term": true, "utm_content": true, "utm_id": true,
	"fbclid": true, "gclid": true, "ref": true, "ref_src": true,
	"spm": true, "share_token": true, "share_source": true,
}

// decodeDataURI decodes a data: URI payload (ICON attributes carry base64
// images). Returns nil for anything non-image or undecodable — icon data is
// strictly best-effort.
func decodeDataURI(raw string) []byte {
	i := strings.Index(raw, "base64,")
	if i < 0 || !strings.HasPrefix(raw, "data:image/") {
		return nil
	}
	data, err := base64.StdEncoding.DecodeString(raw[i+len("base64,"):])
	if err != nil || len(data) == 0 || len(data) > 256<<10 {
		return nil
	}
	return data
}
