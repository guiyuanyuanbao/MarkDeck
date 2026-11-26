// Favicon and extension-download handlers. These lived inline in main.go
// through the audit rounds; they belong with the other handlers so they run
// behind the same middleware and JSON error conventions as the rest of the
// API. Wire format and auth semantics are byte-compatible with the
// previous main.go versions.
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/favicon"
)

// registerFaviconRoutes mounts the favicon store endpoints and the extension
// zip download. extensionVersion is the build-stamped repo VERSION used for
// the fallback filename of the release layout.
func (a *API) RegisterFaviconRoutes(mux *http.ServeMux, fetcher *favicon.Fetcher, extensionVersion string) {
	// GET serves stored bytes verbatim; only real image payloads enter the
	// store (checked below on PUT), so direct navigation cannot render a
	// same-origin document — see the securityHeaders note in main.go.
	mux.HandleFunc("GET /api/favicon/{host}", func(w http.ResponseWriter, r *http.Request) {
		fetcher.ServeHTTP(w, r, r.PathValue("host"))
	})
	mux.HandleFunc("GET /api/extension/download", a.requireAny(a.handleExtensionDownload(extensionVersion)))
	mux.HandleFunc("POST /api/favicon/clear", a.requireSession(a.handleFaviconClear))
	mux.HandleFunc("PUT /api/favicon/{host}", a.requireAny(a.handleFaviconPut))
}

// handleExtensionDownload serves the extension zip shipped next to the
// binary (release layout) so the extension's options page can offer a
// one-click upgrade. Accepts session cookie or device token.
func (a *API) handleExtensionDownload(extensionVersion string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
	}
}

// handleFaviconClear lets the admin wipe stored favicons (whole cache or one
// host) so devices re-push or the fetcher retries — recovers from
// placeholder garbage.
func (a *API) handleFaviconClear(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
	}
	// an unparseable body means "no host given": clear-all is the safe read
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Host == "" {
		if _, err := a.Store.DB.Exec(`DELETE FROM favicons`); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"ok": "1", "cleared": "all"})
		return
	}
	if _, err := a.Store.DB.Exec(`DELETE FROM favicons WHERE host=?`, body.Host); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1", "cleared": body.Host})
}

// handleFaviconPut stores browser-resolved favicons pushed by devices (the
// MV3 _favicon/ endpoint yields the same icon chrome shows, including its
// Google fallback) so every client shares accurate icons without the server
// guessing per-site.
func (a *API) handleFaviconPut(w http.ResponseWriter, r *http.Request) {
	host := favicon.SanitizeHost(r.PathValue("host"))
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad host"})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
	if err != nil || len(data) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	ctype := r.Header.Get("Content-Type")
	if ctype == "" || !strings.HasPrefix(ctype, "image/") {
		ctype = "image/png"
	}
	// stored bytes are served back verbatim by GET /api/favicon/{host}:
	// only real image payloads may enter the store (SVG/script rejected)
	if !favicon.LooksLikeImage(data) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not an image payload"})
		return
	}
	if err := a.Store.FaviconPut(host, ctype, data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}
