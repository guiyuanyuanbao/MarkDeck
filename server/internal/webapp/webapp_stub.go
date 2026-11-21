//go:build nowebapp

// Package webapp fallback used only for backend-only builds: serves a
// minimal placeholder page. Production builds embed web/dist.
package webapp

import "net/http"

func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<!doctype html><html><body style="font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:20vh">
<h1>MarkDeck server is running</h1>
<p>The management UI is not embedded in this build. Build with <code>web/dist</code> present, or download a release binary.</p>
</body></html>`))
	})
}
