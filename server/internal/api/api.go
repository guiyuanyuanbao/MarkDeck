// Package api wires HTTP routing, session auth and all REST handlers.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/auth"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/config"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/sync"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/tools"
)

// API bundles shared dependencies for all handlers.
type API struct {
	Store     *store.Store
	Config    *config.Config
	Auth      *auth.Manager
	Hub       *sync.Hub
	Limiter   *auth.Limiter
	chain     *tools.Chain
	broadcast func(int64)
}

// RegisterTools attaches the maintenance tool chain.
func (a *API) RegisterTools(chain *tools.Chain) { a.chain = chain }

// New constructs the API aggregate.
func New(st *store.Store, cfg *config.Config, am *auth.Manager, hub *sync.Hub) *API {
	a := &API{Store: st, Config: cfg, Auth: am, Hub: hub, Limiter: auth.NewLimiter(5)}
	a.broadcast = hub.Broadcast
	return a
}

// broadcastRevision pushes the current head revision to all WS clients.
func (a *API) broadcastRevision() {
	if head, err := a.Store.MaxRevision(); err == nil {
		a.broadcast(head)
	}
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// csrfGuard rejects state-changing requests whose X-CSRF header does not
// match the session's token. Device-token traffic never calls this (tokens
// don't ride browser cookies, so CSRF does not apply).
func csrfGuard(w http.ResponseWriter, r *http.Request, sess *auth.Session) bool {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		if r.Header.Get("X-CSRF") != sess.CSRF {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "csrf mismatch"})
			return false
		}
	}
	return true
}

func (a *API) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := a.Auth.SessionFromRequest(r)
		if sess == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
			return
		}
		// CSRF: state-changing methods must carry the session's token header.
		if !csrfGuard(w, r, sess) {
			return
		}
		next(w, r)
	}
}

// requireDevice authenticates extension traffic via Bearer device token.
func (a *API) requireDevice(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dev := a.Auth.DeviceFromRequest(r)
		if dev == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "device token required"})
			return
		}
		next(w, r)
	}
}

// requireAny accepts either a valid session cookie or a device bearer token.
// Session-cookie traffic must also present the CSRF header on state-changing
// methods; device-token traffic is exempt (token never rides browser cookies,
// so CSRF does not apply).
func (a *API) requireAny(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// an explicit Bearer token wins over cookies: in the SAME browser the
		// extension's fetch rides along with the web UI's session cookie, and
		// without this the request is treated as session traffic and rejected
		// for a CSRF header the extension never had
		dev := a.Auth.DeviceFromRequest(r)
		var sess *auth.Session // zero value when device-authenticated
		if dev == nil {
			sess = a.Auth.SessionFromRequest(r)
			if sess == nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "auth required"})
				return
			}
		}
		if sess != nil && !csrfGuard(w, r, sess) {
			return
		}
		next(w, r)
	}
}
