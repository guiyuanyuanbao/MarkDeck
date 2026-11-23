// Package auth implements password hashing, session cookies with CSRF
// tokens, login rate limiting, device pairing tokens and optional TOTP.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

// HashPassword derives an argon2id hash (PHC string format) of password.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	// 64 MiB memory, 3 iterations, 4 threads — solid defaults for 2024+.
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 4, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=4$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against a PHC-formatted argon2id hash.
func VerifyPassword(password, phc string) (bool, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("malformed hash")
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("parse params: %w", err)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// RandomToken returns a URL-safe random string with n bytes of entropy.
func RandomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ---- login rate limiting ----

type attemptRecord struct {
	failures  int
	lockUntil time.Time
	lastTry   time.Time
}

// Limiter implements progressive-delay login throttling keyed by remote addr.
type Limiter struct {
	mu       sync.Mutex
	attempts map[string]*attemptRecord
	maxFail  int
}

// NewLimiter creates a limiter that locks an identity after maxFail
// consecutive failures.
func NewLimiter(maxFail int) *Limiter {
	return &Limiter{attempts: map[string]*attemptRecord{}, maxFail: maxFail}
}

// Allow reports whether a login attempt from key may proceed now.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.attempts[key]
	if rec == nil {
		return true
	}
	return time.Now().After(rec.lockUntil)
}

// Fail records a failed attempt and escalates the lock window:
// 1s, 2s, 4s ... capped at 15 minutes once failures exceed maxFail.
func (l *Limiter) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.attempts[key]
	if rec == nil {
		rec = &attemptRecord{}
		l.attempts[key] = rec
	}
	rec.failures++
	rec.lastTry = time.Now()
	if rec.failures >= l.maxFail {
		delay := time.Second << uint(min(rec.failures-l.maxFail, 10))
		if delay > 15*time.Minute {
			delay = 15 * time.Minute
		}
		rec.lockUntil = time.Now().Add(delay)
	}
}

// Succeed clears the failure history for key.
func (l *Limiter) Succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}

// Cleanup drops stale attempt records older than an hour since last try.
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-time.Hour)
	for k, rec := range l.attempts {
		if rec.lastTry.Before(cut) {
			delete(l.attempts, k)
		}
	}
}

// trustProxy is only set when MARKDECK_TRUST_PROXY=1: behind a reverse proxy
// every request shares the proxy's RemoteAddr, so X-Forwarded-For is the only
// usable throttling key — but on a direct deployment trusting that header lets
// an attacker rotate a fresh key per attempt and bypass the limiter entirely.
var trustProxy = os.Getenv("MARKDECK_TRUST_PROXY") == "1"

// ClientKey identifies the caller for throttling: X-Forwarded-For when a
// trusted proxy is configured, else the socket address (uncorruptible).
func ClientKey(r *http.Request) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	return r.RemoteAddr
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
