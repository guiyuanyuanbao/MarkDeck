// Package importexport converts between MarkDeck bookmarks and the
// Netscape bookmark HTML format used by every major browser.
package importexport

import (
	"fmt"
	html "golang.org/x/net/html"
	"sort"
	"strings"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Node is one parsed entry: a folder or a URL.
type Node struct {
	Title    string
	URL      string
	AddDate  int64 // unix seconds
	Children []*Node
}

// ParseNetscapeHTML parses a bookmark export file into a synthetic root.
// Tolerates the messy real-world markup browsers emit (unclosed <DT>,
// <p> interludes, nested DLs).
func ParseNetscapeHTML(data []byte) (*Node, error) {
	root := &Node{Title: "root"}
	stack := []*Node{root}
	var pendingH3 string
	var pendingAdd int64

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
				for _, a := range t.Attr {
					if a.Key == "add_date" {
						pendingAdd = parseTime(a.Val)
					}
				}
			case "a":
				var title, url string
				var add int64
				for _, a := range t.Attr {
					switch a.Key {
					case "href":
						url = a.Val
					case "add_date":
						add = parseTime(a.Val)
					}
				}
				// text follows in next TextToken
				n := &Node{URL: url, AddDate: add}
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
				txt := pendingText(tk)
				if len(stack) > 0 {
					f := &Node{Title: firstNonEmpty(pendingH3, txt), AddDate: pendingAdd}
					// folder node: attach to current parent, push as new context
					parent := stack[len(stack)-1]
					parent.Children = append(parent.Children, f)
					stack = append(stack, f)
				}
			}
		case html.TextToken:
			// h3 text arrives here before </h3>; stash it
			trimmed := strings.TrimSpace(tk.Token().Data)
			if trimmed != "" && pendingH3 == "" {
				// only meaningful inside h3; nextText path covers <a> text
				h3Pending = trimmed
			}
		}
	}
	// close: any folders pushed but never popped still counted in root
	_ = depthDL
	return root, nil
}

var h3Pending string

func pendingText(tk *html.Tokenizer) string {
	txt := h3Pending
	h3Pending = ""
	return txt
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

	var importFolder func(parentID string, n *Node, depth int) (string, error)
	importFolder = func(parentID string, n *Node, depth int) (string, error) {
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
		return res, nil
	}

	// newfolder mode
	r := &Node{Title: firstNonEmpty(opts.RootName, "Imported "+time.Now().Format("2006-01-02")), Children: root.Children}
	rid, err := importFolder("", r, 0)
	if err != nil {
		return nil, err
	}
	res.RootID = rid
	return res, nil
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
	if strings.HasPrefix(host, "www.") {
		host = host[4:]
	}
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
