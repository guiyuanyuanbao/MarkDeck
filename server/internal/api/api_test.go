package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/auth"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/config"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/sync"
)

type testEnv struct {
	api   *API
	dev   struct{ Token string }
	sess  struct{ CSRF, Cookie string }
	store *store.Store
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := &config.Config{Addr: "127.0.0.1:0", DataDir: dir, DBPath: filepath.Join(dir, "t.db")}
	am := auth.NewManager(st, 1, false)
	env := &testEnv{api: New(st, cfg, am, sync.NewHub()), store: st}

	// first-run setup -> logged-in session
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/auth/setup", body(map[string]string{"password": "test-password-123"}))
	env.api.handleSetup(w, r)
	if w.Code != 200 {
		t.Fatalf("setup: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	env.sess.CSRF = resp["csrf"]
	env.sess.Cookie = cookieValue(w)

	// mint a device token the same way pairing does
	code, err := am.NewPairCode("")
	if err != nil {
		t.Fatal(err)
	}
	devID, token, err := am.PairDevice(code, "test-ext")
	if err != nil {
		t.Fatal(err)
	}
	_ = devID
	env.dev.Token = token
	return env
}

func body(v any) *bytes.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func cookieValue(w *httptest.ResponseRecorder) string {
	for _, c := range w.Result().Cookies() {
		if c.Name == "markdeck_session" {
			return c.Value
		}
	}
	return ""
}

// do performs an authenticated JSON request as the admin session.
func (e *testEnv) do(t *testing.T, method, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if payload != nil {
		reader = body(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, reader)
	r.Header.Set("X-CSRF", e.sess.CSRF)
	r.AddCookie(&http.Cookie{Name: "markdeck_session", Value: e.sess.Cookie})
	w := httptest.NewRecorder()
	e.route(method, path, w, r)
	return w
}

// doDev performs a device-token authenticated request (extension traffic).
func (e *testEnv) doDev(t *testing.T, method, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if payload != nil {
		reader = body(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, reader)
	r.Header.Set("Authorization", "Bearer "+e.dev.Token)
	w := httptest.NewRecorder()
	e.route(method, path, w, r)
	return w
}

// route dispatches manually to the handler under test (mirrors Register table).
func (e *testEnv) route(method, path string, w http.ResponseWriter, r *http.Request) {
	switch {
	case method == "GET" && path == "/api/sync/tree":
		e.api.requireDevice(e.api.handleSyncTree)(w, r)
	case method == "POST" && path == "/api/sync/apply":
		e.api.requireDevice(e.api.handleSyncApply)(w, r)
	case method == "GET" && path == "/api/sync/status":
		e.api.requireAny(e.api.handleSyncStatus)(w, r)
	case method == "POST" && path == "/api/bookmarks":
		e.api.requireAny(e.api.handleCreate)(w, r)
	case method == "GET" && path == "/api/bookmarks/tree":
		e.api.requireAny(e.api.handleTree)(w, r)
	case method == "POST" && path == "/api/auth/totp-setup":
		e.api.requireSession(e.api.handleTOTPSetup)(w, r)
	case method == "POST" && path == "/api/auth/totp-enable":
		e.api.requireSession(e.api.handleTOTPEnable)(w, r)
	case method == "GET" && path == "/api/auth/me":
		e.api.requireSession(e.api.handleMe)(w, r)
	default:
		panic("route not mapped: " + method + " " + path)
	}
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("bad json: %v (%s)", err, w.Body.String())
	}
	return m
}

func TestSetupAndSyncFlow(t *testing.T) {
	e := newTestEnv(t)

	// apply two ops: folder + child bookmark
	w := e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "folder-1", "op": "create", "type": "folder", "title": "Tech", "updatedAt": 1000, "deviceId": "ext-1"},
		{"id": "bm-1", "op": "create", "type": "url", "parentId": "folder-1", "title": "Go", "url": "https://go.dev", "updatedAt": 1001, "deviceId": "ext-1"},
	})
	if w.Code != 200 {
		t.Fatalf("apply: %d %s", w.Code, w.Body.String())
	}
	res := decode(t, w)["results"].([]any)
	if len(res) != 2 {
		t.Fatalf("want 2 results, got %d", len(res))
	}
	r0 := res[0].(map[string]any)
	if r0["win"] != true {
		t.Fatalf("op0 should win: %v", r0)
	}

	// full tree -> both rows (+ the permanent canonical 其他书签 holder)
	w = e.doDev(t, "GET", "/api/sync/tree", nil)
	m := decode(t, w)
	nodes := m["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("tree nodes = %d (want folder+bookmark+canonical holder)", len(nodes))
	}
	if m["othersId"] != store.CanonicalOthersID() {
		t.Fatalf("tree must carry the canonical others id: %v", m["othersId"])
	}

	// LWW: older write loses
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "bm-1", "op": "update", "title": "older title", "updatedAt": 500, "deviceId": "ext-2"},
	})
	r := decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != false {
		t.Fatalf("older apply should lose: %v", r)
	}
	state := r["state"].(map[string]any)
	if state["title"] != "Go" {
		t.Fatalf("server kept winner: %v", state["title"])
	}

	// newer write wins
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "bm-1", "op": "update", "title": "Go (official)", "updatedAt": 2000, "deviceId": "ext-2"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != true {
		t.Fatalf("newer apply should win: %v", r)
	}

	// delete: subtree tombstoned
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "folder-1", "op": "delete", "updatedAt": 3000, "deviceId": "ext-1"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != true {
		t.Fatalf("delete should win: %v", r)
	}
	// tree no longer carries them (reconciler's deletion signal). The
	// canonical 其他书签 holder is a permanent row, so it stays.
	w = e.doDev(t, "GET", "/api/sync/tree", nil)
	nodes = decode(t, w)["nodes"].([]any)
	if len(nodes) != 1 {
		t.Fatalf("tree after delete = %d, want just the canonical holder", len(nodes))
	}

	// stale update against a deleted row re-creates it (repair path)
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "bm-1", "op": "update", "type": "url", "parentId": "folder-1",
			"title": "Go", "url": "https://go.dev", "updatedAt": 4000, "deviceId": "ext-2"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != true {
		t.Fatalf("re-apply after delete should re-create: %v", r)
	}

	// status head > 0
	w = e.doDev(t, "GET", "/api/sync/status", nil)
	if head, ok := decode(t, w)["head"].(float64); !ok || head < 4 {
		t.Fatalf("status head = %v", head)
	}
}

func TestSyncTreeRequiresDeviceAuth(t *testing.T) {
	e := newTestEnv(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/sync/tree", nil)
	e.route("GET", "/api/sync/tree", w, r)
	if w.Code != 401 {
		t.Fatalf("unauthed tree = %d", w.Code)
	}
	// bad token -> 401
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/sync/tree", nil)
	r.Header.Set("Authorization", "Bearer wrong")
	e.route("GET", "/api/sync/tree", w, r)
	if w.Code != 401 {
		t.Fatalf("bad token tree = %d", w.Code)
	}
	// CSRF mismatch on a session-authed POST to a requireAny endpoint -> 403
	// (apply is device-only: session traffic there gets 401, tested above)
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/api/bookmarks", bytes.NewReader([]byte(`{}`)))
	r.AddCookie(&http.Cookie{Name: "markdeck_session", Value: e.sess.Cookie})
	r.Header.Set("X-CSRF", "wrong")
	e.route("POST", "/api/bookmarks", w, r)
	if w.Code != 403 {
		t.Fatalf("csrf mismatch = %d", w.Code)
	}
}

func TestSyncApplyBadPayload(t *testing.T) {
	e := newTestEnv(t)
	w := e.doDev(t, "POST", "/api/sync/apply", "not-an-array")
	if w.Code != 400 {
		t.Fatalf("bad payload = %d", w.Code)
	}
	// empty batch is a no-op with the current head
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{})
	m := decode(t, w)
	if _, ok := m["head"].(float64); !ok {
		t.Fatalf("empty batch must return head: %v", m)
	}
	// unknown op name errors per-op, never 500s
	w = e.doDev(t, "POST", "/api/sync/apply", []map[string]any{
		{"id": "x", "op": "explode", "updatedAt": 1, "deviceId": "d"},
	})
	res := decode(t, w)["results"].([]any)[0].(map[string]any)
	if res["error"] == nil {
		t.Fatalf("unknown op must error: %v", res)
	}
	if !strings.Contains(res["error"].(string), "unknown op") {
		t.Fatalf("error should name the problem: %v", res)
	}
}
