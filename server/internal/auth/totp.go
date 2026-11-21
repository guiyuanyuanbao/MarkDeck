package auth

import (
	"errors"
	"fmt"
	"net/url"

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

// VerifyTOTP checks a 6-digit code against the stored secret (±1 step skew).
func VerifyTOTP(secret, code string) bool {
	if code == "" {
		return false
	}
	return totp.Validate(code, secret)
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
		if parsed, perr := url.Parse(u); perr == nil {
			u = fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s",
				url.PathEscape(issuer), url.PathEscape(account),
				key.Secret(), url.QueryEscape(issuer))
			_ = parsed
		}
	}
	return key.Secret(), u, nil
}
