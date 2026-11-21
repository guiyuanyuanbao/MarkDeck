//go:build !nowebapp

// The embed requires the dist directory to exist at build time. When
// building without the frontend (e.g. quick backend-only compile), the
// fallback build tag `nowebapp` serves a stub index instead.
//
package webapp

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// Handler serves the SPA with index.html fallback for client routes.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(sub, p); err != nil {
			// SPA fallback: unknown paths render the app shell.
			if !strings.Contains(r.URL.Path, ".") {
				r.URL.Path = "/"
			}
		}
		// Static assets are content-hashed by Vite; safe to cache hard.
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	})
}
