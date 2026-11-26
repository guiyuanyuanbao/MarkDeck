// Command markdeck is the single-binary self-hosted bookmark server.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
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
	mux.HandleFunc("GET /api/favicon/{host}", func(w http.ResponseWriter, r *http.Request) {
		fetcher.ServeHTTP(w, r, r.PathValue("host"))
	})
	// serves the extension zip shipped next to the binary (release layout)
	// so the extension's options page can offer a one-click upgrade
	mux.HandleFunc("GET /api/extension/download", func(w http.ResponseWriter, r *http.Request) {
		if a.Auth.DeviceFromRequest(r) == nil && a.Auth.SessionFromRequest(r) == nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		data, err := os.ReadFile("markdeck-extension.zip")
		if err != nil {
			// fallback: the versioned release file name
			data, err = os.ReadFile("markdeck-extension-" + extensionVersion + ".zip")
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="markdeck-extension-`+extensionVersion+`.zip"`)
		w.Write(data)
	})
	// admin clears stored favicons (whole cache or one host) so devices
	// re-push, or the fetcher retries — recovers from placeholder garbage
	mux.HandleFunc("POST /api/favicon/clear", func(w http.ResponseWriter, r *http.Request) {
		if a.Auth.SessionFromRequest(r) == nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Host string `json:"host"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Host == "" {
			if _, err := st.DB.Exec(`DELETE FROM favicons`); err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"ok": "1", "cleared": "all"})
			return
		}
		if _, err := st.DB.Exec(`DELETE FROM favicons WHERE host=?`, body.Host); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"ok": "1", "cleared": body.Host})
	})
	// devices push browser-resolved favicons (MV3 _favicon/ endpoint yields
	// the same icon chrome shows, including its Google fallback) so every
	// client shares accurate icons without the server guessing per-site
	mux.HandleFunc("PUT /api/favicon/{host}", func(w http.ResponseWriter, r *http.Request) {
		if a.Auth.DeviceFromRequest(r) == nil && a.Auth.SessionFromRequest(r) == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "auth required"})
			return
		}
		host := favicon.SanitizeHost(r.PathValue("host"))
		if host == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "bad host"})
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
		if err != nil || len(data) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "bad body"})
			return
		}
		ctype := r.Header.Get("Content-Type")
		if ctype == "" || !strings.HasPrefix(ctype, "image/") {
			ctype = "image/png"
		}
		// stored bytes are served back verbatim by GET /api/favicon/{host}:
		// only real image payloads may enter the store (SVG/script rejected)
		if !favicon.LooksLikeImage(data) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "not an image payload"})
			return
		}
		if err := st.FaviconPut(host, ctype, data); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"ok": "1"})
	})
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

var _ = filepath.Join
