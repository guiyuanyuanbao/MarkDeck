// Command markdeck is the single-binary self-hosted bookmark server.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/api"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/auth"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/config"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/favicon"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/sync"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/tools"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/webapp"
)

// extensionVersion is stamped at build time from the repo VERSION file.
var extensionVersion = ""

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	secure := strings.HasPrefix(strings.ToLower(cfg.BaseURL), "https://")
	am := auth.NewManager(st, cfg.SessionTTLHours, secure)
	hub := sync.NewHub()
	// injected via -ldflags "-X main.extensionVersion=$(cat VERSION)"
	if cfg.ExtensionVersion == "" && extensionVersion != "" {
		cfg.ExtensionVersion = extensionVersion
	}
	chain := tools.NewChain(st, cfg.SnapshotDir, func(rev int64) {
		// tools historically broadcast literal 0, which the hub's monotonic
		// filter always dropped — snapshot restores/dead-link scans never
		// woke live devices. Resolve the real head instead.
		if rev > 0 {
			hub.Broadcast(rev)
			return
		}
		if head, err := st.MaxRevision(); err == nil && head > 0 {
			hub.Broadcast(head)
		}
	})
	fetcher := favicon.NewFetcher(st)
	// runtime proxy: the admin UI writes proxy settings; outbound favicon /
	// dead-link fetches pick it up on the next request (no restart)
	favicon.ProxyFunc = func() *url.URL {
		raw, err := st.SettingsGet("network_proxy")
		if err != nil || raw == "" {
			return nil
		}
		u, err := url.Parse(raw)
		if err != nil {
			return nil
		}
		return u
	}
	a := api.New(st, cfg, am, hub)
	a.RegisterTools(chain)

	mux := http.NewServeMux()
	a.Register(mux)
	a.RegisterToolsRoutes(mux, chain)
	a.RegisterFaviconRoutes(mux, fetcher, extensionVersion)
	mux.Handle("/", securityHeaders(webapp.Handler()))
	// The API routes serve user-controlled bytes too (favicon store), so
	// every handler runs behind the same security headers: without nosniff
	// an image/svg+xml payload from PUT /api/favicon/{host} could be
	// rendered as a same-origin document by direct navigation — a stored
	// XSS with no CSP to stop it.
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// background jobs: hourly session cleanup + daily snapshot + weekly dead-link scan
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go backgroundJobs(ctx, st, chain, am)

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatalf("listen %s: %v", cfg.Addr, err)
	}
	log.Printf("MarkDeck listening on http://%s  (data: %s)", cfg.Addr, cfg.DataDir)
	if !am.HasPassword() {
		log.Printf("First run: open the UI to create the admin password.")
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case <-ctx.Done():
		log.Printf("shutting down...")
		shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}
	log.Printf("bye")
}

func backgroundJobs(ctx context.Context, st *store.Store, chain *tools.Chain, am *auth.Manager) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now().Unix()
			if err := st.CleanupSessions(now); err != nil {
				log.Printf("session cleanup: %v", err)
			}
			chain.CleanupSnapshots()
			// trash retention: purge rows past the configured window (no-op
			// when retention is 0/never)
			chain.EnforceTrashRetention(now)
			// daily-ish snapshot: run when local hour is 3
			if time.Now().Hour() == 3 {
				if _, err := chain.TakeSnapshot("daily"); err != nil {
					log.Printf("snapshot: %v", err)
				}
			}
			// weekly dead-link scan on Sundays at 3am hour
			if time.Now().Weekday() == time.Sunday && time.Now().Hour() == 3 {
				go chain.ScanDeadLinks(ctx)
			}
		}
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "+
				"script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		next.ServeHTTP(w, r)
	})
}
