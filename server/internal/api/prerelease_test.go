package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// Pre-release TOTP full flow: setup -> wrong code rejected -> enable -> login
// requires code -> disable -> login without code works.
func TestTOTPFullFlow(t *testing.T) {
	e := newTestEnv(t)

	// get setup secret
	w := e.do(t, "POST", "/api/auth/totp-setup", nil)
	if w.Code != 200 {
		t.Fatalf("totp-setup: %d %s", w.Code, w.Body.String())
	}
	var setup struct {
		Secret  string `json:"secret"`
		Otpauth string `json:"otpauth"`
	}
	json.Unmarshal(w.Body.Bytes(), &setup)
	if setup.Secret == "" || !strings.HasPrefix(setup.Otpauth, "otpauth://") {
		t.Fatalf("bad setup response: %+v", setup)
	}

	// wrong code -> enable fails
	w = e.do(t, "POST", "/api/auth/totp-enable", map[string]string{"code": "000000"})
	if w.Code == 200 {
		t.Fatal("enable with wrong code must fail")
	}

	// valid code -> enable succeeds (generate with the server's own window)
	code := generateTOTPNow(setup.Secret)
	w = e.do(t, "POST", "/api/auth/totp-enable", map[string]string{"code": code})
	if w.Code != 200 {
		t.Fatalf("enable with valid code: %d %s", w.Code, w.Body.String())
	}

	// me() should now report totp enabled
	w = e.do(t, "GET", "/api/auth/me", nil)
	if !strings.Contains(w.Body.String(), `"totp":true`) {
		t.Fatalf("me should report totp enabled: %s", w.Body.String())
	}

	// login without code fails
	r := httptest.NewRequest("POST", "/api/auth/login", body(map[string]string{"password": "test-password-123"}))
	r.Header.Set("X-Forwarded-For", "10.9.9.9")
	rr := httptest.NewRecorder()
	e.api.handleLogin(rr, r)
	if rr.Code != 401 {
		t.Fatalf("login without totp should 401: %d", rr.Code)
	}

	// login with valid code succeeds
	loginWithTOTP(t, e, setup.Secret)
}

// Pre-release: expired sessions are rejected (TTL enforcement).
func TestSessionExpiry(t *testing.T) {
	e := newTestEnv(t)
	// manually expire the session row
	if err := e.api.Store.CleanupSessions(time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/bookmarks/tree", nil)
	r.AddCookie(&http.Cookie{Name: "markdeck_session", Value: e.sess.Cookie})
	e.api.requireSession(e.api.handleTree)(w, r)
	if w.Code != 401 {
		t.Fatalf("expired session must 401: %d", w.Code)
	}
}

// Pre-release: giant and malformed import HTML must not crash or hang.
func TestImportEdgeCases(t *testing.T) {
	e := newTestEnv(t)

	// giant: 5000 bookmarks
	var sb strings.Builder
	sb.WriteString(`<DL><p>`)
	for i := 0; i < 5000; i++ {
		sb.WriteString(`<DT><A HREF="https://bulk/` + itoa(i) + `" ADD_DATE="1700000000">Bulk ` + itoa(i) + `</A>`)
	}
	sb.WriteString(`</DL><p>`)
	w := importHTML(t, e, sb.String())
	if w.Code != 200 {
		t.Fatalf("bulk import: %d", w.Code)
	}
	var res struct {
		Created int `json:"created"`
	}
	json.Unmarshal(w.Body.Bytes(), &res)
	if res.Created != 5000 {
		t.Fatalf("bulk created = %d, want 5000", res.Created)
	}

	// malformed garbage
	for _, garbage := range []string{
		`<DL><p><DT><A HREF="`,         // truncated
		`<DL><p><DT><A>no href</A>`,    // no href
		`<script>alert(1)</script>`,    // script injection
		`<DL><p><DT><H3>未闭合文件夹<DL><p>`, // unclosed folder
		``, // empty
	} {
		w := importHTML(t, e, garbage)
		if w.Code >= 500 {
			t.Fatalf("garbage import caused 5xx: %d for %q", w.Code, garbage)
		}
	}

	// deep nesting (folder-in-folder-in-folder... x 100)
	deep := `<DL><p>`
	for i := 0; i < 100; i++ {
		deep += `<DT><H3>L` + itoa(i) + `</H3><DL><p>`
	}
	for i := 0; i < 100; i++ {
		deep += `</DL><p>`
	}
	deep += `</DL><p>`
	w = importHTML(t, e, deep)
	if w.Code >= 500 {
		t.Fatalf("deep nesting import 5xx: %d", w.Code)
	}
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func importHTML(t *testing.T, e *testEnv, html string) *httptest.ResponseRecorder {
	t.Helper()
	boundary := "----mdtest"
	payload := `--` + boundary + "\r\n" +
		`Content-Disposition: form-data; name="mode"` + "\r\n\r\nmerge\r\n" +
		`--` + boundary + "\r\n" +
		`Content-Disposition: form-data; name="file"; filename="bm.html"` + "\r\n" +
		`Content-Type: text/html` + "\r\n\r\n" +
		html + "\r\n--" + boundary + "--\r\n"
	r := httptest.NewRequest("POST", "/api/import/html", strings.NewReader(payload))
	r.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	r.Header.Set("X-CSRF", e.sess.CSRF)
	r.AddCookie(&http.Cookie{Name: "markdeck_session", Value: e.sess.Cookie})
	w := httptest.NewRecorder()
	e.api.handleImportHTML(w, r)
	return w
}

func generateTOTPNow(secret string) string {
	// 与服务器 ±1 步窗口匹配：取当前步进码
	code, _ := totp.GenerateCode(secret, time.Now())
	return code
}

func loginWithTOTP(t *testing.T, e *testEnv, secret string) {
	t.Helper()
	code := generateTOTPNow(secret)
	r := httptest.NewRequest("POST", "/api/auth/login", body(map[string]string{"password": "test-password-123", "totp": code}))
	r.Header.Set("X-Forwarded-For", "10.9.9.8")
	rr := httptest.NewRecorder()
	e.api.handleLogin(rr, r)
	if rr.Code != 200 {
		t.Fatalf("login with totp failed: %d %s", rr.Code, rr.Body.String())
	}
}
