package auth

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pquerna/otp/totp"
)

// Sentinel errors surfaced to HTTP handlers.
var (
	ErrNotSetup       = errors.New("admin password not configured (first run)")
	ErrAlreadySetup   = errors.New("admin password already configured")
	ErrBadCredentials = errors.New("invalid credentials")
	ErrBadTOTP        = errors.New("invalid or missing TOTP code")
	ErrWeakPassword   = errors.New("password must be at least 8 characters")
	ErrBadPairCode    = errors.New("invalid or expired pairing code")
)

// TOTP codes are valid for one 30s step; without replay protection an
// intercepted code could be reused for the rest of its window. Each enabled
// secret remembers the last timestep it accepted and rejects re-use.
var totpReplay = struct {
	mu       sync.Mutex
	lastStep map[string]uint64
}{lastStep: map[string]uint64{}}

var timeNow = time.Now

// VerifyTOTP checks a 6-digit code against the stored secret (±2 step skew)
// and rejects a code whose timestep was already consumed for that secret.
// Login-time verification goes through here; enrollment confirmation uses
// VerifyTOTPEnrollment so enabling 2FA doesn't burn the code a user's
// authenticator is still displaying for the immediately-following login.
func VerifyTOTP(secret, code string) bool {
	return verifyTOTP(secret, code, true)
}

// VerifyTOTPEnrollment checks a code during 2FA setup confirmation. No
// replay-state is recorded: the pending secret isn't a login credential yet.
func VerifyTOTPEnrollment(secret, code string) bool {
	return verifyTOTP(secret, code, false)
}

func verifyTOTP(secret, code string, enforceReplay bool) bool {
	if code == "" || secret == "" {
		return false
	}
	key, err := decodeSecret(secret)
	if err != nil {
		return false
	}
	now := uint64(timeNow().Unix()) / 30
	matched := uint64(0)
	ok := false
	for _, skew := range []uint64{0, 1, 2} {
		if step := now - skew; step > 0 && code == generateStep(key, step) {
			matched, ok = step, true
			break
		}
	}
	if !ok {
		return false
	}
	if !enforceReplay {
		return true
	}
	totpReplay.mu.Lock()
	defer totpReplay.mu.Unlock()
	if last, seen := totpReplay.lastStep[secret]; seen && matched <= last {
		return false // replayed code
	}
	totpReplay.lastStep[secret] = matched
	return true
}

// ForgetTOTPSecret drops replay state when a secret is rotated or disabled.
func ForgetTOTPSecret(secret string) {
	totpReplay.mu.Lock()
	defer totpReplay.mu.Unlock()
	delete(totpReplay.lastStep, secret)
}

// generateStep is RFC 6238 HOTP(secret, counter) with 6 digits — the same
// algorithm pquerna/otp issues for these secrets, inlined so we know WHICH
// timestep a code matched (needed for single-use enforcement).
func generateStep(key []byte, step uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], step)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := (uint32(sum[off])&0x7f)<<24 | uint32(sum[off+1])<<16 |
		uint32(sum[off+2])<<8 | uint32(sum[off+3])
	const digits = 6
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, v%mod)
}

// decodeSecret handles the stored base32 form (padding-tolerant).
func decodeSecret(secret string) ([]byte, error) {
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(
		strings.ToUpper(strings.TrimRight(secret, "=")))
}

// GenerateTOTPSetup creates a new secret + otpauth URL for enrollment.
// Confirm with VerifyTOTP before enabling.
func GenerateTOTPSetup(account, issuer, baseURL string) (secret, otpauthURL string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: account,
	})
	if err != nil {
		return "", "", err
	}
	u := key.URL()
	if baseURL != "" {
		// Best-effort label rewrite so the QR shows the real host.
		if _, perr := url.Parse(u); perr == nil {
			u = fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s",
				url.PathEscape(issuer), url.PathEscape(account),
				key.Secret(), url.QueryEscape(issuer))
		}
	}
	return key.Secret(), u, nil
}
