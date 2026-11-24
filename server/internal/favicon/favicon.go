// Package favicon fetches and caches site icons for bookmarks.
//
// Strategy per host:
//  1. ask https://host/favicon.ico
//  2. if that fails/looks wrong, parse the site's HTML for <link rel="icon">
//  3. cache positive results as raw image bytes; cache failures too, so a
//     dead site doesn't get re-fetched on every page load
package favicon

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

const (
	// how long a positive cache entry is considered fresh
	freshTTL = 7 * 24 * time.Hour
	// how long to wait after a failed fetch before retrying
	retryAfterFail = 24 * time.Hour
	maxIconBytes   = 256 << 10 // 256 KiB
	maxPageBytes   = 512 << 10
)

var client = &http.Client{
	Timeout: 8 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
	},
}

// Fetcher resolves favicons with single-flight dedup per host.
type Fetcher struct {
	Store *store.Store

	mu    sync.Mutex
	inFly map[string]*sync.WaitGroup
}

// NewFetcher builds a Fetcher.
func NewFetcher(st *store.Store) *Fetcher {
	return &Fetcher{Store: st, inFly: map[string]*sync.WaitGroup{}}
}

// ServeHTTP answers GET /api/favicon/{host}. With ?probe=1 it answers
// strictly from the cache — 200 only when a real icon is stored, 404
// otherwise — and never triggers a server-side fetch (the extension's
// favicon push relies on this to decide whether to upload).
func (f *Fetcher) ServeHTTP(w http.ResponseWriter, r *http.Request, host string) {
	if r.URL.Query().Get("probe") == "1" {
		host = sanitizeHost(host)
		row, err := f.Store.FaviconGet(host)
		if err != nil || len(row.Data) == 0 || row.FailedAt > 0 {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", row.ContentType)
		w.Header().Set("Cache-Control", "no-store")
		w.Write(row.Data)
		return
	}
	data, ctype, ok := f.resolve(r.Context(), host)
	if !ok {
		// deterministic transparent placeholder so <img> shows alt cleanly
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "public, max-age=604800") // 7d; keys are versionless but content changes rarely
	w.Write(data)
}

func (f *Fetcher) resolve(ctx context.Context, host string) (data []byte, ctype string, ok bool) {
	host = sanitizeHost(host)
	if host == "" {
		return nil, "", false
	}

	// cache hit?
	if row, err := f.Store.FaviconGet(host); err == nil {
		if row.FailedAt > 0 {
			// negative cache
			if time.Since(time.Unix(row.FailedAt, 0)) < retryAfterFail {
				return nil, "", false
			}
		} else if len(row.Data) > 0 && time.Since(time.Unix(row.FetchedAt, 0)) < freshTTL {
			return row.Data, row.ContentType, true
		}
	}

	// single-flight
	f.mu.Lock()
	if wg, busy := f.inFly[host]; busy {
		f.mu.Unlock()
		wg.Wait()
		if row, err := f.Store.FaviconGet(host); err == nil && len(row.Data) > 0 {
			return row.Data, row.ContentType, true
		}
		return nil, "", false
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	f.inFly[host] = wg
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		delete(f.inFly, host)
		f.mu.Unlock()
		wg.Done()
	}()

	data, ctype, ok = f.fetchHost(ctx, host)
	if ok {
		_ = f.Store.FaviconPut(host, ctype, data)
	} else {
		_ = f.Store.FaviconMarkFailed(host)
	}
	return data, ctype, ok
}

func (f *Fetcher) fetchHost(ctx context.Context, host string) ([]byte, string, bool) {
	base := "https://" + host

	// 1) favicon.ico
	if data, ctype, ok := fetchBinary(ctx, base+"/favicon.ico"); ok {
		return data, ctype, true
	}
	// 2) parse HTML <link rel="icon">
	if iconURL, ok2 := fetchIconFromHTML(ctx, base); ok2 {
		if data, ctype, ok := fetchBinary(ctx, iconURL); ok {
			return data, ctype, true
		}
	}
	// 3) icon aggregator fallbacks (works for most live sites)
	if data, ctype, ok := fetchBinary(ctx, "https://icons.duckduckgo.com/ip3/"+host+".ico"); ok {
		return data, ctype, true
	}
	if data, ctype, ok := fetchBinary(ctx, "https://www.google.com/s2/favicons?domain="+host+"&sz=64"); ok {
		return data, ctype, true
	}
	return nil, "", false
}

func fetchBinary(ctx context.Context, url string) ([]byte, string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; MarkDeck/1.0; favicon fetcher)")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", false
	}
	ctype := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ctype, "image/") && !strings.Contains(ctype, "octet-stream") && ctype != "" {
		return nil, "", false
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxIconBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxIconBytes {
		return nil, "", false
	}
	// sanity: image magic bytes
	if !looksLikeImage(data) {
		return nil, "", false
	}
	if ctype == "" {
		ctype = sniffType(data)
	}
	return data, ctype, true
}

func fetchIconFromHTML(ctx context.Context, base string) (string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; MarkDeck/1.0; favicon fetcher)")
	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	doc, err := html.Parse(io.LimitReader(resp.Body, maxPageBytes))
	if err != nil {
		return "", false
	}
	best := ""
	score := 0
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && (n.Data == "link" || n.Data == "meta") {
			var rel, href string
			for _, a := range n.Attr {
				switch a.Key {
				case "rel":
					rel = strings.ToLower(a.Val)
				case "href", "content":
					href = a.Val
				}
			}
			prio := 0
			switch {
			case strings.Contains(rel, "apple-touch-icon"):
				prio = 4
			case strings.Contains(rel, "shortcut icon"), rel == "icon":
				prio = 3
			case strings.Contains(rel, "icon"):
				prio = 2
			case n.Data == "meta" && rel == "og:image" || href != "" && n.Data == "meta" && strings.Contains(strings.ToLower(rel), "image"):
				prio = 1
			}
			if prio > score && href != "" {
				score = prio
				best = href
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if best == "" {
		return "", false
	}
	if !strings.HasPrefix(best, "http") {
		if strings.HasPrefix(best, "//") {
			best = "https:" + best
		} else {
			best = base + "/" + strings.TrimPrefix(best, "/")
		}
	}
	return best, true
}

func looksLikeImage(b []byte) bool {
	if len(b) < 6 {
		return false
	}
	if len(b) >= 12 && string(b[8:12]) == "WEBP" {
		return true
	}
	if b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' { // PNG
		return true
	}
	if b[0] == 0xFF && b[1] == 0xD8 { // JPEG
		return true
	}
	if b[0] == 'G' && b[1] == 'I' && b[2] == 'F' { // GIF
		return true
	}
	if b[0] == '<' && b[1] == 's' && b[2] == 'v' && b[3] == 'g' { // SVG
		return true
	}
	if (b[0] == 0x00 && b[1] == 0x00) || (b[0] == 'I' && b[1] == 'C') { // ICO
		return true
	}
	return false
}

func sniffType(b []byte) string {
	switch {
	case b[0] == 0x89 && b[1] == 'P':
		return "image/png"
	case b[0] == 0xFF && b[1] == 0xD8:
		return "image/jpeg"
	case b[0] == 'G' && b[1] == 'I':
		return "image/gif"
	case b[0] == '<':
		return "image/svg+xml"
	default:
		return "image/x-icon"
	}
}

// sanitizeHost keeps only reasonable hostname characters.
// SanitizeHost is the exported form of sanitizeHost (device favicon push).
func SanitizeHost(host string) string { return sanitizeHost(host) }

func sanitizeHost(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	host = strings.TrimSuffix(host, "/")
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexAny(host, "/:?#"); i >= 0 {
		host = host[:i]
	}
	if host == "" || strings.ContainsAny(host, " <>\"'\\") {
		return ""
	}
	return host
}
