package auth

import (
	"testing"
	"time"
)

// A verified login code must be single-use: an intercepted code replayed
// within its 30s window (or the ±2 step skew) must be rejected.
func TestTOTPReplayRejected(t *testing.T) {
	sec := testSecret(t)
	key, err := decodeSecret(sec)
	if err != nil {
		t.Fatal(err)
	}
	step := uint64(timeNow().Unix()) / 30
	code := generateStep(key, step)
	if !VerifyTOTP(sec, code) {
		t.Fatal("first use should verify")
	}
	if VerifyTOTP(sec, code) {
		t.Fatal("replayed code must be rejected")
	}
	// strict single-use: after accepting step N, ANY code of timestep <= N
	// is refused — an attacker who captured one code cannot fall back to a
	// still-displayed neighbor code from the same skew window
	older := generateStep(key, step-1)
	if VerifyTOTP(sec, older) {
		t.Fatal("codes of consumed-or-earlier timesteps must be rejected")
	}
	ForgetTOTPSecret(sec)
}

// Enrollment confirmation must NOT consume the timestep: enabling 2FA and
// logging in within the same 30s window (same displayed code) is the normal
// user flow.
func TestTOTPEnrollmentDoesNotConsume(t *testing.T) {
	sec := testSecret(t)
	code := generateCodeNow(t, sec)
	if !VerifyTOTPEnrollment(sec, code) {
		t.Fatal("enrollment verify failed")
	}
	if !VerifyTOTP(sec, code) {
		t.Fatal("login with the same freshly-enabled code must succeed")
	}
	if VerifyTOTP(sec, code) {
		t.Fatal("but the login verification is still single-use")
	}
	ForgetTOTPSecret(sec)
}

func testSecret(t *testing.T) string {
	t.Helper()
	sec, _, err := GenerateTOTPSetup("admin", "MarkDeck", "")
	if err != nil {
		t.Fatal(err)
	}
	return sec
}

func generateCodeNow(t *testing.T, sec string) string {
	t.Helper()
	key, err := decodeSecret(sec)
	if err != nil {
		t.Fatal(err)
	}
	return generateStep(key, uint64(timeNow().Unix())/30)
}

var _ = time.Now
