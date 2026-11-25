package api

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/auth"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/sync"
)

// Register mounts all routes on mux, including the WebSocket endpoint.
func (a *API) Register(mux *http.ServeMux) {
	// ---- public ----
	mux.HandleFunc("POST /api/auth/login", a.handleLogin)
	mux.HandleFunc("POST /api/auth/setup", a.handleSetup)
	mux.HandleFunc("GET /api/auth/state", a.handleAuthState) // first-run detection
	mux.HandleFunc("POST /api/pair", a.handlePairExchange)   // pair-code -> device token

	// ---- device-token (extension, snapshot reconciliation) ----
	mux.HandleFunc("GET /api/sync/tree", a.requireDevice(a.handleSyncTree))
	mux.HandleFunc("POST /api/sync/apply", a.requireDevice(a.handleSyncApply))

	// ---- session (admin UI) ----
	mux.HandleFunc("POST /api/auth/logout", a.requireSession(a.handleLogout))
	mux.HandleFunc("GET /api/auth/me", a.requireSession(a.handleMe))
	mux.HandleFunc("POST /api/auth/change-password", a.requireSession(a.handleChangePassword))
	mux.HandleFunc("GET /api/auth/totp-setup", a.requireSession(a.handleTOTPSetup))
	mux.HandleFunc("POST /api/auth/totp-enable", a.requireSession(a.handleTOTPEnable))
	mux.HandleFunc("POST /api/auth/totp-disable", a.requireSession(a.handleTOTPDisable))

	mux.HandleFunc("POST /api/pair-code", a.requireSession(a.handleNewPairCode))
	mux.HandleFunc("GET /api/extension/update", a.handleExtensionUpdate)
	mux.HandleFunc("GET /api/network/proxy", a.requireSession(a.handleGetProxy))
	mux.HandleFunc("POST /api/network/proxy", a.requireSession(a.handleSetProxy))
	mux.HandleFunc("GET /api/devices", a.requireSession(a.handleListDevices))
	mux.HandleFunc("DELETE /api/devices/{id}", a.requireSession(a.handleRevokeDevice))

	// bookmarks
	mux.HandleFunc("GET /api/bookmarks/tree", a.requireAny(a.handleTree))
	mux.HandleFunc("POST /api/bookmarks", a.requireAny(a.handleCreate))
	mux.HandleFunc("PUT /api/bookmarks/{id}", a.requireAny(a.handleUpdate))
	mux.HandleFunc("DELETE /api/bookmarks/{id}", a.requireAny(a.handleDelete))
	mux.HandleFunc("POST /api/bookmarks/{id}/restore", a.requireAny(a.handleRestore))
	mux.HandleFunc("POST /api/bookmarks/{id}/purge", a.requireAny(a.handlePurge))
	mux.HandleFunc("POST /api/bookmarks/batch", a.requireAny(a.handleBatch))
	mux.HandleFunc("PUT /api/bookmarks/{id}/tags", a.requireAny(a.handleSetTags))
	mux.HandleFunc("POST /api/bookmarks/{id}/move", a.requireAny(a.handleMove))
	mux.HandleFunc("POST /api/bookmarks/reorder", a.requireAny(a.handleReorder))

	mux.HandleFunc("GET /api/tags", a.requireAny(a.handleListTags))
	mux.HandleFunc("POST /api/tags/rename", a.requireAny(a.handleRenameTag))
	mux.HandleFunc("POST /api/tags/delete", a.requireAny(a.handleDeleteTag))
	mux.HandleFunc("GET /api/search", a.requireAny(a.handleSearch))
	mux.HandleFunc("GET /api/stats", a.requireAny(a.handleStats))
	mux.HandleFunc("GET /api/trash", a.requireAny(a.handleTrash))

	// sync (shared)
	mux.HandleFunc("GET /api/sync/status", a.requireAny(a.handleSyncStatus))

	// websocket
	mux.HandleFunc("GET /api/ws", func(w http.ResponseWriter, r *http.Request) {
		a.Hub.HandleWS(w, r, func(req *http.Request) bool {
			if a.Auth.SessionFromRequest(req) != nil || a.Auth.DeviceFromRequest(req) != nil {
				return true
			}
			// Browser WS cannot send Authorization headers; the extension
			// passes its device token via query param instead.
			return a.Auth.DeviceByToken(req.URL.Query().Get("token")) != nil
		})
	})
}

// ---- auth handlers ----

func (a *API) handleAuthState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"setup": !a.Auth.HasPassword(),
		"totp":  a.Auth.TOTPEnabled(),
	})
}

func (a *API) handleSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if err := a.Auth.SetupPassword(body.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	csrf, err := a.Auth.Login(w, r, body.Password, "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"csrf": csrf})
}

func (a *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	key := auth.ClientKey(r)
	if !a.Limiter.Allow(key) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, wait"})
		return
	}
	var body struct {
		Password string `json:"password"`
		TOTP     string `json:"totp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	csrf, err := a.Auth.Login(w, r, body.Password, body.TOTP)
	if err != nil {
		a.Limiter.Fail(key)
		status := http.StatusUnauthorized
		if err == auth.ErrNotSetup {
			status = http.StatusPreconditionRequired
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	a.Limiter.Succeed(key)
	writeJSON(w, http.StatusOK, map[string]string{"csrf": csrf})
}

func (a *API) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.Auth.Logout(w, r)
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleMe(w http.ResponseWriter, r *http.Request) {
	sess := a.Auth.SessionFromRequest(r)
	csrf := ""
	if sess != nil {
		csrf = sess.CSRF
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"admin": true,
		"totp":  a.Auth.TOTPEnabled(),
		"csrf":  csrf, // lets the SPA restore its CSRF token after a page reload
	})
}

func (a *API) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if err := a.Auth.ChangePassword(body.Old, body.New); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	if a.Auth.TOTPEnabled() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "totp already enabled"})
		return
	}
	secret, urlStr, err := auth.GenerateTOTPSetup("admin", "MarkDeck", a.Config.BaseURL)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.Store.SettingsSet("totp_pending_secret", secret); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"secret": secret, "otpauth": urlStr})
}

func (a *API) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	pending, _ := a.Store.SettingsGet("totp_pending_secret")
	if pending == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no pending setup"})
		return
	}
	if !auth.VerifyTOTPEnrollment(pending, body.Code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": auth.ErrBadTOTP.Error()})
		return
	}
	if err := a.Store.SettingsSet("totp_secret", pending); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	_ = a.Store.SettingsSet("totp_enabled", "1")
	_ = a.Store.SettingsSet("totp_pending_secret", "")
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	if secret, _ := a.Store.SettingsGet("totp_secret"); secret != "" {
		auth.ForgetTOTPSecret(secret)
	}
	_ = a.Store.SettingsSet("totp_enabled", "0")
	_ = a.Store.SettingsSet("totp_secret", "")
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

// ---- pair / devices ----

// handleGetProxy / handleSetProxy: the outbound proxy used for favicon and
// dead-link fetches. Stored in settings; the fetchers read it per request.
func (a *API) handleGetProxy(w http.ResponseWriter, r *http.Request) {
	v, _ := a.Store.SettingsGet("network_proxy")
	writeJSON(w, http.StatusOK, map[string]string{"proxy": v})
}

func (a *API) handleSetProxy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Proxy string `json:"proxy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	p := strings.TrimSpace(body.Proxy)
	if p != "" {
		u, err := url.Parse(p)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5") || u.Host == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "代理格式无效（支持 http/https/socks5://host:port）"})
			return
		}
	}
	if err := a.Store.SettingsSet("network_proxy", p); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

// handleExtensionUpdate tells the extension which version is current so its
// options page can surface "new version available" with a direct download
// link (unpacked MV3 installs can't self-update; a version banner is the
// practical substitute for the store update flow).
func (a *API) handleExtensionUpdate(w http.ResponseWriter, r *http.Request) {
	v := strings.TrimSpace(a.Config.ExtensionVersion)
	if v == "" {
		writeJSON(w, http.StatusOK, map[string]string{"version": ""})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"version": v,
		"url":     strings.TrimSuffix(a.Config.BaseURL, "/") + "/api/extension/download",
	})
}

func (a *API) handleNewPairCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceName string `json:"deviceName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	name := strings.TrimSpace(body.DeviceName)
	if len(name) > 60 {
		name = name[:60]
	}
	code, err := a.Auth.NewPairCode(name)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code, "expiresIn": "300"})
}

func (a *API) handlePairExchange(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	id, token, err := a.Auth.PairDevice(body.Code, body.Name)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("paired device %s (%s)", id, body.Name)
	// wake the admin UI: its device list refreshes on revision pings
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]string{"deviceId": id, "token": token})
}

func (a *API) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devs, err := a.Auth.ListDevices()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	// online = synced within the last 2 minutes (device tokens touch
	// last_seen on every pull/push/WS-auth, so any live sync keeps it fresh)
	type deviceView struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		ClientName string `json:"clientName,omitempty"`
		CreatedAt  int64  `json:"createdAt"`
		LastSeen   int64  `json:"lastSeen"`
		Online     bool   `json:"online"`
	}
	const onlineWindow = 120 // seconds
	views := make([]deviceView, 0, len(devs))
	now := store.Now()
	for _, d := range devs {
		views = append(views, deviceView{
			ID: d.ID, Name: d.Name, ClientName: d.ClientName, CreatedAt: d.Created, LastSeen: d.LastSeen,
			Online: d.LastSeen > 0 && now-d.LastSeen <= onlineWindow,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": views})
}

func (a *API) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if err := a.Auth.RevokeDevice(r.PathValue("id")); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

var _ = sync.NewHub
