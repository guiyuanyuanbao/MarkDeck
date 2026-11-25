// Package tools implements maintenance utilities: dead-link scanning,
// duplicate detection and JSON snapshots with retention.
package tools

import (
	"net/url"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/favicon"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Chain bundles the three maintenance tools sharing one store.
type Chain struct {
	Store       *store.Store
	SnapshotDir string
	Broadcast   func(int64)

	// scan state
	mu          sync.Mutex
	deadRunning bool
	lastDeadAt  int64
}

// NewChain wires a Chain.
func NewChain(st *store.Store, snapshotDir string, broadcast func(int64)) *Chain {
	_ = os.MkdirAll(snapshotDir, 0o700)
	c := &Chain{Store: st, SnapshotDir: snapshotDir, Broadcast: broadcast}
	// migration 0005 moved dead-link state to its own table; scrub the
	// pseudo-tags legacy scans left on bookmarks (one-time, cheap)
	go c.PurgeLegacyDeadTags()
	return c
}

// ---- dead links ----

// DeadState columns are stored as pseudo-tags to avoid schema churn:
// tags like "_dead:404", "_checked:1699999999". This keeps the sync
// protocol unchanged for all clients.

var httpClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy: func(req *http.Request) (*url.URL, error) {
			if p := favicon.ProxyFunc(); p != nil {
				return p, nil
			}
			return nil, nil
		},
		MaxIdleConns:        32,
		MaxConnsPerHost:     2,
		IdleConnTimeout:     60 * time.Second,
		DialContext:         (&net.Dialer{Timeout: 8 * time.Second}).DialContext,
		TLSHandshakeTimeout: 8 * time.Second,
	},
}

// ScanDeadLinks checks every live URL bookmark. Concurrency is bounded and
// per-host requests are serialized by MaxConnsPerHost=2 above. Results are
// recorded as internal tags; errors keep the bookmark untouched.
func (c *Chain) ScanDeadLinks(ctx context.Context) (int, error) {
	c.mu.Lock()
	if c.deadRunning {
		c.mu.Unlock()
		return 0, fmt.Errorf("scan already running")
	}
	c.deadRunning = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.deadRunning = false
		c.lastDeadAt = store.Now()
		c.mu.Unlock()
	}()

	nodes, err := c.Store.Tree()
	if err != nil {
		return 0, err
	}
	var urls []*store.Bookmark
	for _, n := range nodes {
		if n.Type == "url" && strings.HasPrefix(n.URL, "http") {
			urls = append(urls, n)
		}
	}

	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	var checked int64

	for _, b := range urls {
		select {
		case <-ctx.Done():
			wg.Wait()
			return int(atomic.LoadInt64(&checked)), ctx.Err()
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(bm *store.Bookmark) {
			defer wg.Done()
			defer func() { <-sem }()
			status := checkURL(bm.URL)
			recordDeadLink(c.Store, bm.ID, status)
			atomic.AddInt64(&checked, 1)
		}(b)
	}
	wg.Wait()
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return int(atomic.LoadInt64(&checked)), nil
}

// checkURL performs HEAD then GET fallback; returns "ok" or "code:<n>".
func checkURL(url string) string {
	req, err := http.NewRequest(http.MethodHead, url, nil)
	if err != nil {
		return "dead"
	}
	req.Header.Set("User-Agent", "MarkDeck/1.0 (+link-checker)")
	resp, err := httpClient.Do(req)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode < 400 || resp.StatusCode == http.StatusMethodNotAllowed {
			return statusStr(resp.StatusCode)
		}
		// HEAD rejected -> try GET
		req2, _ := http.NewRequest(http.MethodGet, url, nil)
		req2.Header.Set("User-Agent", "MarkDeck/1.0 (+link-checker)")
		resp2, err2 := httpClient.Do(req2)
		if err2 == nil {
			resp2.Body.Close()
			return statusStr(resp2.StatusCode)
		}
	}
	return "dead"
}

// statusStr classifies a response. 405/403/429 usually mean anti-bot
// measures rather than a dead link, so they are marked separately.
func statusStr(code int) string {
	if code >= 200 && code < 400 {
		return "ok"
	}
	if code == 403 || code == 405 || code == 429 {
		return fmt.Sprintf("blocked:%d", code)
	}
	return fmt.Sprintf("http:%d", code)
}

// recordDeadLink writes the check outcome to the dead_links table (replaces
// the old _dead:/_checked: pseudo-tags that polluted the user's tag list).
func recordDeadLink(s *store.Store, bookmarkID, status string) {
	_, err := s.DB.Exec(`INSERT INTO dead_links(bookmark_id, status, checked_at)
		VALUES(?,?,?)
		ON CONFLICT(bookmark_id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at`,
		bookmarkID, status, store.Now())
	_ = err
}

// PurgeLegacyDeadTags strips the old _dead:/_checked: pseudo-tags from every
// bookmark (migration 0005 moved state to dead_links; one-time cleanup runs
// at startup via NewChain's first use).
func (c *Chain) PurgeLegacyDeadTags() {
	rows, err := c.Store.DB.Query(`SELECT b.id, b.tags FROM bookmarks b
		JOIN bookmark_tags bt ON bt.bookmark_id = b.id
		WHERE bt.tag LIKE '\_%dead:%' OR bt.tag LIKE '\_%checked:%'`)
	if err != nil {
		return
	}
	type idTags struct {
		id   string
		tags []string
	}
	var targets []idTags
	seen := map[string]bool{}
	for rows.Next() {
		var id, tag string
		if err := rows.Scan(&id, &tag); err != nil {
			continue
		}
		if !strings.HasPrefix(tag, "_dead:") && !strings.HasPrefix(tag, "_checked:") {
			continue
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		bm, err := c.Store.Get(id)
		if err != nil {
			continue
		}
		var keep []string
		for _, t := range bm.Tags {
			if !strings.HasPrefix(t, "_dead:") && !strings.HasPrefix(t, "_checked:") {
				keep = append(keep, t)
			}
		}
		targets = append(targets, idTags{id: id, tags: keep})
	}
	rows.Close()
	for _, t := range targets {
		_, _ = c.Store.SetTags(t.id, t.tags, "tools")
	}
}

// filterInternalTags strips underscore-prefixed tags from user-facing output.
func FilterInternalTags(tags []string) []string {
	var out []string
	for _, t := range tags {
		if !strings.HasPrefix(t, "_") {
			out = append(out, t)
		}
	}
	return out
}

// ScanStatus reports whether a dead-link scan is currently running.
func (c *Chain) ScanStatus() (running bool, lastAt int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.deadRunning, c.lastDeadAt
}

// DeadLinks returns bookmarks currently tagged dead, with status and age.
type DeadLink struct {
	Bookmark *store.Bookmark `json:"bookmark"`
	Status   string          `json:"status"`
	Checked  int64           `json:"checked"`
}

func (c *Chain) DeadLinks() ([]DeadLink, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	byID := map[string]*store.Bookmark{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	rows, err := c.Store.DB.Query(`SELECT bookmark_id, status, checked_at FROM dead_links ORDER BY checked_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeadLink
	for rows.Next() {
		var id, status string
		var checked int64
		if err := rows.Scan(&id, &status, &checked); err != nil {
			continue
		}
		n, ok := byID[id]
		if !ok {
			continue // trashed/purged since the scan
		}
		out = append(out, DeadLink{
			Bookmark: withFilteredTags(n),
			Status:   status,
			Checked:  checked,
		})
	}
	return out, nil
}

func withFilteredTags(n *store.Bookmark) *store.Bookmark {
	cp := *n
	cp.Tags = FilterInternalTags(n.Tags)
	return &cp
}

// ---- duplicates ----

// DupGroup is one normalized URL shared by >=2 live bookmarks.
type DupGroup struct {
	Key   string            `json:"key"`
	Items []*store.Bookmark `json:"items"`
}

// FindDuplicates groups live URL bookmarks by normalized URL (same rules as
// import dedupe: tracking params stripped, www/scheme ignored).
// FolderDupGroup is a set of same-named folders under the same parent —
// artifacts of the multi-device initial-import bug (each device pushed its
// own folder tree before UUID adoption existed).
type FolderDupGroup struct {
	ParentID string            `json:"parentId"`
	Title    string            `json:"title"`
	Items    []*store.Bookmark `json:"items"`
}

// FindFolderDuplicates groups live folders by (parent, title).
func (c *Chain) FindFolderDuplicates() ([]FolderDupGroup, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	groups := map[string][]*store.Bookmark{}
	var order []string
	for _, n := range nodes {
		if n.Type != "folder" {
			continue
		}
		// 其他书签 holders are per-device buckets, not user duplicates —
		// exclude them by their stable id prefix instead of by parent
		// (the user's duplicated folders live at top level!)
		if strings.HasPrefix(n.ID, "others-") {
			continue
		}
		key := n.ParentID + "\x00" + strings.TrimSpace(n.Title)
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], n)
	}
	var out []FolderDupGroup
	for _, k := range order {
		items := groups[k]
		if len(items) >= 2 {
			parts := strings.SplitN(k, "\x00", 2)
			out = append(out, FolderDupGroup{ParentID: parts[0], Title: parts[1], Items: items})
		}
	}
	return out, nil
}

// MergeFolderDuplicates merges a duplicate-folder group: every child of each
// removed folder moves into the kept folder (deduped by url|title within the
// target), then the shells are trashed. Children of children follow their
// parent, so deep subtrees move intact.
func (c *Chain) MergeFolderDuplicates(keepID string, removeIDs []string) (moved int, err error) {
	keep, err := c.Store.Get(keepID)
	if err != nil {
		return 0, err
	}
	if keep.Type != "folder" {
		return 0, fmt.Errorf("keepID must be a folder")
	}
	at := store.Now()
	for _, id := range removeIDs {
		rm, err := c.Store.Get(id)
		if err != nil {
			continue
		}
		if rm.Type != "folder" || rm.DeletedAt > 0 {
			continue
		}
		// re-parent every live child into the kept folder
		kids, err := c.Store.Children(id)
		if err != nil {
			return moved, err
		}
		// build the target's existing url|title set for dedup
		targetKids, err := c.Store.Children(keepID)
		if err != nil {
			return moved, err
		}
		seen := map[string]bool{}
		for _, tk := range targetKids {
			if tk.URL != "" {
				seen[strings.TrimRight(tk.URL, "/")+"|"+tk.Title] = true
			}
		}
		pos := float64(len(targetKids))
		for _, kid := range kids {
			// url children that already exist (url|title) in the target are
			// dropped along with their subtree; folders always move
			if kid.URL != "" && seen[strings.TrimRight(kid.URL, "/")+"|"+kid.Title] {
				if _, err := c.Store.DeleteSoft(kid.ID, at, "tools"); err != nil {
					return moved, err
				}
				continue
			}
			if _, err := c.Store.Move(kid.ID, keepID, pos+1, at, "tools"); err != nil {
				return moved, err
			}
			pos++
			moved++
			if kid.URL != "" {
				seen[strings.TrimRight(kid.URL, "/")+"|"+kid.Title] = true
			}
		}
		// shell is now empty — trash it (subtree was already moved out)
		if _, err := c.Store.DeleteSoft(id, at, "tools"); err != nil {
			return moved, err
		}
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return moved, nil
}

// ValidateDuplicateGroup confirms keep+remove ids really belong to one
// duplicate-URL group (same normalized key, ≥2 members). Merge deletes its
// inputs, so without this the endpoint was an arbitrary-delete primitive.
func (c *Chain) ValidateDuplicateGroup(keepID string, removeIDs []string) error {
	nodes, err := c.Store.Tree()
	if err != nil {
		return err
	}
	byID := map[string]*store.Bookmark{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	keep, ok := byID[keepID]
	if !ok || keep.Type != "url" {
		return fmt.Errorf("keepId %s is not a live url bookmark", keepID)
	}
	key := normalizeForDup(keep.URL)
	for _, rid := range removeIDs {
		rm, ok := byID[rid]
		if !ok || rm.Type != "url" || normalizeForDup(rm.URL) != key {
			return fmt.Errorf("removeId %s is not a duplicate of the keep bookmark", rid)
		}
	}
	return nil
}

// ValidateFolderDuplicateGroup confirms keep+remove are same-parent
// same-title folder groups — the only shape MergeFolderDuplicates may
// consume (same arbitrary-delete concern as ValidateDuplicateGroup).
func (c *Chain) ValidateFolderDuplicateGroup(keepID string, removeIDs []string) error {
	nodes, err := c.Store.Tree()
	if err != nil {
		return err
	}
	byID := map[string]*store.Bookmark{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	keep, ok := byID[keepID]
	if !ok || keep.Type != "folder" {
		return fmt.Errorf("keepId %s is not a live folder", keepID)
	}
	for _, rid := range removeIDs {
		rm, ok := byID[rid]
		if !ok || rm.Type != "folder" || rm.ParentID != keep.ParentID || rm.Title != keep.Title {
			return fmt.Errorf("removeId %s is not a same-folder duplicate of the keep folder", rid)
		}
	}
	return nil
}

func (c *Chain) FindDuplicates() ([]DupGroup, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	groups := map[string][]*store.Bookmark{}
	for _, n := range nodes {
		if n.Type != "url" || n.URL == "" {
			continue
		}
		key := normalizeForDup(n.URL)
		groups[key] = append(groups[key], withFilteredTags(n))
	}
	var out []DupGroup
	for k, items := range groups {
		if len(items) >= 2 {
			sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt < items[j].CreatedAt })
			out = append(out, DupGroup{Key: k, Items: items})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// normalizeForDup mirrors importexport.normURL but without the import
// package dependency (kept in lockstep by test).
func normalizeForDup(raw string) string {
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
			if trackingParam(k) {
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

func trackingParam(k string) bool {
	switch k {
	case "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
		"utm_id", "fbclid", "gclid", "ref", "ref_src", "spm", "share_token", "share_source":
		return true
	}
	return false
}

// MergeDuplicate keeps the preferred bookmark (first by createdAt) and moves
// others to trash, merging their tags into the survivor.
func (c *Chain) MergeDuplicate(keepID string, removeIDs []string) error {
	keep, err := c.Store.Get(keepID)
	if err != nil {
		return err
	}
	at := store.Now()
	for _, id := range removeIDs {
		rm, err := c.Store.Get(id)
		if err != nil {
			continue
		}
		// absorb tags + note
		merged := map[string]bool{}
		for _, t := range keep.Tags {
			merged[t] = true
		}
		newTags := keep.Tags
		for _, t := range rm.Tags {
			if !strings.HasPrefix(t, "_") && !merged[t] {
				newTags = append(newTags, t)
			}
		}
		if keep.Note == "" && rm.Note != "" {
			keep.Note = rm.Note
		}
		if len(newTags) != len(keep.Tags) || keep.Note != rm.Note && rm.Note != "" {
			keep.Tags = newTags
		}
		keep.UpdatedAt = at
		keep.DeviceID = "tools"
		if _, _, err := c.Store.UpdateLWWBase(keep, newTags, keep.Revision); err != nil {
			return err
		}
		// move duplicate to trash
		if _, err := c.Store.DeleteSoft(id, at, "tools"); err != nil {
			return err
		}
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	_ = keep
	return nil
}

// ---- snapshots ----

// TakeSnapshot writes a gzipped JSON dump of all rows (including tombstones)
// and registers it in the snapshots table.
func (c *Chain) TakeSnapshot(cause string) (*store.SnapshotRow, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	trash, err := c.Store.Trash()
	if err != nil {
		return nil, err
	}
	all := append(nodes, trash...)
	payload, err := json.Marshal(map[string]any{"exportedAt": store.Now(), "bookmarks": all})
	if err != nil {
		return nil, err
	}

	id, err := store.NewUUID()
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("snapshot-%s-%s.json.gz", time.Now().Format("20060102-150405"), id[:8])
	f, err := os.Create(filepath.Join(c.SnapshotDir, name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	if _, err := gz.Write(payload); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	row := &store.SnapshotRow{ID: id, CreatedAt: store.Now(), Size: fi.Size(), File: name, Cause: cause}
	if err := c.Store.InsertSnapshot(row); err != nil {
		return nil, err
	}
	return row, nil
}

// ListSnapshots returns snapshot metadata, newest first.
func (c *Chain) ListSnapshots() ([]*store.SnapshotRow, error) { return c.Store.ListSnapshots() }

// SnapshotPath resolves the absolute file for a snapshot id.
func (c *Chain) SnapshotPath(id string) (string, *store.SnapshotRow, error) {
	return c.Store.SnapshotFile(id, c.SnapshotDir)
}

// CleanupSnapshots enforces the retention policy: keep newest 30.
func (c *Chain) CleanupSnapshots() {
	rows, err := c.Store.ListSnapshots()
	if err != nil || len(rows) <= 30 {
		return
	}
	for _, old := range rows[30:] {
		_ = os.Remove(filepath.Join(c.SnapshotDir, old.File))
		_ = c.Store.DeleteSnapshot(old.ID)
	}
}

// RestoreSnapshot replaces the live tree with the snapshot contents.
// A protective snapshot of the current state is taken first.
func (c *Chain) RestoreSnapshot(id string, deviceID string) error {
	path, row, err := c.SnapshotPath(id)
	if err != nil {
		return err
	}
	_ = row
	if _, err := c.TakeSnapshot("pre-restore"); err != nil {
		return fmt.Errorf("protective snapshot failed: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	gz, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return fmt.Errorf("snapshot corrupt: %w", err)
	}
	defer gz.Close()
	var payload struct {
		Bookmarks []*store.Bookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(gz).Decode(&payload); err != nil {
		return fmt.Errorf("snapshot decode: %w", err)
	}
	if err := c.Store.RestoreFromDump(payload.Bookmarks, deviceID); err != nil {
		return err
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return nil
}

func i64s(v int64) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func s2i64(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int64(s[i]-'0')
	}
	return n
}
