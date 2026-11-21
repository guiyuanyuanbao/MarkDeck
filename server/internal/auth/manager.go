package auth

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// TokenHash re-exports the store helper so callers hash tokens consistently.
var TokenHash = store.TokenHash

// TOTPEnabled reports whether two-factor auth is active.
func (m *Manager) TOTPEnabled() bool {
	v, _ := m.Store.SettingsGet("totp_enabled")
	return v == "1"
}

// Session is an authenticated admin browser session.
type Session struct {
	ID   string // hashed token
	CSRF string
}

// Manager owns session lifecycle and device tokens on top of the store.
type Manager struct {
	Store      *store.Store
	CookieName string
	Secure     bool // set Secure attribute when served over HTTPS
	ttl        time.Duration
}

// NewManager wires a Manager. secure should be true when BASE_URL is https.
func NewManager(st *store.Store, ttlHours int, secure bool) *Manager {
	return &Manager{
		Store:      st,
		CookieName: "markdeck_session",
		Secure:     secure,
		ttl:        time.Duration(ttlHours) * time.Hour,
	}
}

// HasPassword reports whether an admin password is configured (first-run
// setup gates on this).
func (m *Manager) HasPassword() bool {
	v, _ := m.Store.SettingsGet("admin_password_hash")
	return v != ""
}

// ---- sessions ----

// Login verifies password (+optional TOTP code), creates a session row and
// sets the cookie. Returns CSRF token on success.
func (m *Manager) Login(w http.ResponseWriter, r *http.Request, password, totpCode string) (string, error) {
	hash, _ := m.Store.SettingsGet("admin_password_hash")
	if hash == "" {
		return "", ErrNotSetup
	}
	ok, err := VerifyPassword(password, hash)
	if err != nil || !ok {
		return "", ErrBadCredentials
	}
	secret, _ := m.Store.SettingsGet("totp_secret")
	enabled, _ := m.Store.SettingsGet("totp_enabled")
	if secret != "" && enabled == "1" {
		if !VerifyTOTP(secret, totpCode) {
			return "", ErrBadTOTP
		}
	}
	token, err := RandomToken(32)
	if err != nil {
		return "", err
	}
	csrf, err := RandomToken(24)
	if err != nil {
		return "", err
	}
	now := time.Now()
	if err := m.Store.InsertSession(TokenHash(token), csrf, now.Unix(), now.Add(m.ttl).Unix()); err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name: m.CookieName, Value: token, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: m.Secure, MaxAge: int(m.ttl.Seconds()),
	})
	return csrf, nil
}

// Logout deletes the session and clears the cookie.
func (m *Manager) Logout(w http.ResponseWriter, r *http.Request) {
	if s := m.SessionFromRequest(r); s != nil {
		_ = m.Store.DeleteSession(s.ID)
	}
	http.SetCookie(w, &http.Cookie{
		Name: m.CookieName, Value: "", Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: m.Secure, MaxAge: -1,
	})
}

// SessionFromRequest resolves the cookie to a live session or nil.
func (m *Manager) SessionFromRequest(r *http.Request) *Session {
	c, err := r.Cookie(m.CookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	sess, ok := m.Store.ValidSession(TokenHash(c.Value), time.Now().Unix())
	if !ok {
		return nil
	}
	return &Session{ID: TokenHash(c.Value), CSRF: sess.CSRF}
}

// SetupPassword is the first-run flow: only works when no password exists.
func (m *Manager) SetupPassword(password string) error {
	if m.HasPassword() {
		return ErrAlreadySetup
	}
	if len(password) < 8 {
		return ErrWeakPassword
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return m.Store.SettingsSet("admin_password_hash", hash)
}

// ChangePassword replaces the password after verifying the old one.
func (m *Manager) ChangePassword(oldPw, newPw string) error {
	hash, _ := m.Store.SettingsGet("admin_password_hash")
	ok, _ := VerifyPassword(oldPw, hash)
	if !ok {
		return ErrBadCredentials
	}
	if len(newPw) < 8 {
		return ErrWeakPassword
	}
	newHash, err := HashPassword(newPw)
	if err != nil {
		return err
	}
	if err := m.Store.SettingsSet("admin_password_hash", newHash); err != nil {
		return err
	}
	// Invalidate all existing sessions.
	return m.Store.DeleteAllSessions()
}

// ---- device tokens (extension) ----

// Device is the API-facing view of a paired extension.
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Created  int64  `json:"createdAt"`
	LastSeen int64  `json:"lastSeen"`
}

// PairDevice exchanges a valid pairing code for a long-lived device token.
func (m *Manager) PairDevice(code, name string) (deviceID, token string, err error) {
	if !m.Store.ConsumePairCode(code) {
		return "", "", ErrBadPairCode
	}
	token, err = RandomToken(32)
	if err != nil {
		return "", "", err
	}
	id, err := m.Store.CreateDevice(TokenHash(token), name)
	if err != nil {
		return "", "", err
	}
	return id, token, nil
}

// DeviceFromRequest authenticates Authorization: Bearer <token>.
// DeviceByToken authenticates a raw device token — used for WebSocket
// upgrades from the extension, where browsers cannot attach custom headers.
func (m *Manager) DeviceByToken(token string) *store.DeviceRow {
	if token == "" {
		return nil
	}
	return m.Store.TouchDevice(TokenHash(token), time.Now().Unix())
}

func (m *Manager) DeviceFromRequest(r *http.Request) *store.DeviceRow {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil
	}
	token := strings.TrimPrefix(h, "Bearer ")
	if token == "" {
		return nil
	}
	return m.Store.TouchDevice(TokenHash(token), time.Now().Unix())
}

// ListDevices returns all paired devices.
func (m *Manager) ListDevices() ([]Device, error) {
	rows, err := m.Store.ListDevices()
	if err != nil {
		return nil, err
	}
	out := make([]Device, 0, len(rows))
	for _, d := range rows {
		out = append(out, Device{ID: d.ID, Name: d.Name, Created: d.CreatedAt, LastSeen: d.LastSeen})
	}
	return out, nil
}

// RevokeDevice deletes a device; its token stops working immediately.
func (m *Manager) RevokeDevice(id string) error { return m.Store.DeleteDevice(id) }

// ---- pairing codes ----

var pairMu sync.Mutex

// NewPairCode creates a fresh 6-digit code valid for 5 minutes.
func (m *Manager) NewPairCode() (string, error) {
	pairMu.Lock()
	defer pairMu.Unlock()
	code, err := randomDigits(6)
	if err != nil {
		return "", err
	}
	if err := m.Store.SavePairCode(code, time.Now().Add(5*time.Minute).Unix()); err != nil {
		return "", err
	}
	return code, nil
}

func randomDigits(n int) (string, error) {
	b, err := RandomToken(16) // reuse base64url entropy
	if err != nil {
		return "", err
	}
	var digits []byte
	for i := 0; i < len(b) && len(digits) < n; i++ {
		if b[i] >= '0' && b[i] <= '9' {
			digits = append(digits, b[i])
		}
	}
	for len(digits) < n {
		// Extremely unlikely; pad deterministically.
		digits = append(digits, '0'+byte(len(digits)))
	}
	return string(digits), nil
}
