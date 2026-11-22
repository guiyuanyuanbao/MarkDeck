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
	api  *API
	sess struct{ CSRF, Cookie string }
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
	env := &testEnv{api: New(st, cfg, am, sync.NewHub())}

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

// route dispatches manually to the handler under test (mirrors Register table).
func (e *testEnv) route(method, path string, w http.ResponseWriter, r *http.Request) {
	switch {
	case method == "GET" && strings.HasPrefix(path, "/api/sync/pull"):
		e.api.requireAny(e.api.handleSyncPull)(w, r)
	case method == "POST" && path == "/api/sync/push":
		e.api.requireAny(e.api.handleSyncPush)(w, r)
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

	// push two ops: folder + child bookmark
	w := e.do(t, "POST", "/api/sync/push", []map[string]any{
		{"id": "folder-1", "type": "folder", "title": "Tech", "updatedAt": 1000, "deviceId": "ext-1"},
		{"id": "bm-1", "type": "url", "parentId": "folder-1", "title": "Go", "url": "https://go.dev", "updatedAt": 1001, "deviceId": "ext-1", "tags": []string{"dev"}},
	})
	res := decode(t, w)["results"].([]any)
	if len(res) != 2 {
		t.Fatalf("want 2 results, got %d", len(res))
	}
	r0 := res[0].(map[string]any)
	if r0["win"] != true {
		t.Fatalf("op0 should win: %v", r0)
	}

	// pull since 0 -> both rows
	w = e.do(t, "GET", "/api/sync/pull?since=0", nil)
	m := decode(t, w)
	changes := m["changes"].([]any)
	if len(changes) != 2 {
		t.Fatalf("pull changes = %d", len(changes))
	}

	// LWW: older write loses
	w = e.do(t, "POST", "/api/sync/push", []map[string]any{
		{"id": "bm-1", "title": "older title", "updatedAt": 500, "deviceId": "ext-2"},
	})
	r := decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != false {
		t.Fatalf("older push should lose: %v", r)
	}
	state := r["state"].(map[string]any)
	if state["title"] != "Go" {
		t.Fatalf("server kept winner: %v", state["title"])
	}

	// newer write wins
	w = e.do(t, "POST", "/api/sync/push", []map[string]any{
		{"id": "bm-1", "title": "Go (official)", "updatedAt": 2000, "deviceId": "ext-2"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != true {
		t.Fatalf("newer push should win: %v", r)
	}

	// delete then re-push un-delete -> purged stays terminal only after purge
	w = e.do(t, "POST", "/api/sync/push", []map[string]any{
		{"id": "bm-1", "deletedAt": 3000, "updatedAt": 3000, "deviceId": "ext-1"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != true {
		t.Fatalf("delete push should win: %v", r)
	}
	// stale resurrect attempt loses (its updatedAt is older)
	w = e.do(t, "POST", "/api/sync/push", []map[string]any{
		{"id": "bm-1", "deletedAt": 0, "updatedAt": 2500, "deviceId": "ext-2"},
	})
	r = decode(t, w)["results"].([]any)[0].(map[string]any)
	if r["win"] != false {
		t.Fatalf("stale resurrect should lose: %v", r)
	}

	// status head > 0
	w = e.do(t, "GET", "/api/sync/status", nil)
	if head, ok := decode(t, w)["head"].(float64); !ok || head < 4 {
		t.Fatalf("status head = %v", decode(t, w)["head"])
	}
}

func TestAuthGuards(t *testing.T) {
	e := newTestEnv(t)
	// no cookie -> 401
	r := httptest.NewRequest("GET", "/api/sync/pull", nil)
	w := httptest.NewRecorder()
	e.api.handleSyncPull(w, r)
	// requireAny wrapper not applied here; call through route
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/sync/pull", nil)
	e.route("GET", "/api/sync/pull", w, r)
	if w.Code != 401 {
		t.Fatalf("unauthed pull = %d", w.Code)
	}
	// CSRF mismatch -> 403
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/api/sync/push", bytes.NewReader([]byte("[]")))
	r.AddCookie(&http.Cookie{Name: "markdeck_session", Value: e.sess.Cookie})
	r.Header.Set("X-CSRF", "wrong")
	e.route("POST", "/api/sync/push", w, r)
	if w.Code != 403 {
		t.Fatalf("csrf mismatch = %d", w.Code)
	}
}
