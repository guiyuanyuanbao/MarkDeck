// Dead-link scanning: bounded-concurrency HEAD/GET checks over every live
// URL bookmark, results persisted in dead_links (legacy pseudo-tags purged).
package tools

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/favicon"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

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
// Write failures are intentionally non-fatal — a scan must not abort because
// one row could not be recorded — but they are logged for diagnosis.
func recordDeadLink(s *store.Store, bookmarkID, status string) {
	if _, err := s.DB.Exec(`INSERT INTO dead_links(bookmark_id, status, checked_at)
		VALUES(?,?,?)
		ON CONFLICT(bookmark_id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at`,
		bookmarkID, status, store.Now()); err != nil {
		log.Printf("recordDeadLink %s: %v", bookmarkID, err)
	}
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
