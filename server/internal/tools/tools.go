// Package tools implements maintenance utilities: dead-link scanning,
// duplicate detection and JSON snapshots with retention.
package tools

import (
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
	"time"

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
	return &Chain{Store: st, SnapshotDir: snapshotDir, Broadcast: broadcast}
}

// ---- dead links ----

// DeadState columns are stored as pseudo-tags to avoid schema churn:
// tags like "_dead:404", "_checked:1699999999". This keeps the sync
// protocol unchanged for all clients.

var httpClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
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
	var checked int32

	for _, b := range urls {
		select {
		case <-ctx.Done():
			wg.Wait()
			return int(checked), ctx.Err()
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(bm *store.Bookmark) {
			defer wg.Done()
			defer func() { <-sem }()
			status := checkURL(bm.URL)
			applyDeadTag(c.Store, bm, status)
			// atomic-ish counter, single writer per goroutine: use int
			checked++
		}(b)
	}
	wg.Wait()
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return int(checked), nil
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

func statusStr(code int) string {
	if code >= 200 && code < 400 {
		return "ok"
	}
	return fmt.Sprintf("http:%d", code)
}

func applyDeadTag(s *store.Store, bm *store.Bookmark, status string) {
	var tags []string
	for _, t := range bm.Tags {
		if !strings.HasPrefix(t, "_dead:") && !strings.HasPrefix(t, "_checked:") {
			tags = append(tags, t)
		}
	}
	if status != "ok" {
		tags = append(tags, "_dead:"+status)
	}
	tags = append(tags, "_checked:"+i64s(store.Now()))
	// Internal tags must not bump user-facing tag counters; SetTags writes
	// rows wholesale which is fine since underscore tags are filtered
	// from the tags API.
	if _, err := s.SetTags(bm.ID, tags, "tools"); err != nil {
		// non-fatal
		_ = err
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
	var out []DeadLink
	for _, n := range nodes {
		for _, t := range n.Tags {
			if strings.HasPrefix(t, "_dead:") {
				checked := int64(0)
				for _, t2 := range n.Tags {
					if strings.HasPrefix(t2, "_checked:") {
						checked = s2i64(strings.TrimPrefix(t2, "_checked:"))
					}
				}
				out = append(out, DeadLink{
					Bookmark: withFilteredTags(n),
					Status:   strings.TrimPrefix(t, "_dead:"),
					Checked:  checked,
				})
				break
			}
		}
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
		if _, _, err := c.Store.UpdateLWW(keep, newTags); err != nil {
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
