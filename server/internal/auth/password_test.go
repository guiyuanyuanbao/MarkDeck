package auth

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashRoundtrip(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := VerifyPassword("correct horse battery staple", h); !ok {
		t.Fatal("correct password rejected")
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password accepted")
	}
	// PHC format sanity
	if len(h) < 80 || !strings.HasPrefix(h, "$argon2id$v") {
		t.Fatalf("bad phc: %q", h[:20])
	}
}

func TestLimiterProgressiveLock(t *testing.T) {
	l := NewLimiter(3)
	key := "1.2.3.4:5"
	for i := 0; i < 3; i++ {
		if !l.Allow(key) {
			t.Fatalf("attempt %d should be allowed", i)
		}
		l.Fail(key)
	}
	if l.Allow(key) {
		t.Fatal("should be locked after max failures")
	}
	l.Succeed(key)
	if !l.Allow(key) {
		t.Fatal("succeed clears lock")
	}
}

func TestLimiterIndependentKeys(t *testing.T) {
	l := NewLimiter(2)
	l.Fail("a")
	l.Fail("a")
	if l.Allow("a") {
		t.Fatal("a locked")
	}
	if !l.Allow("b") {
		t.Fatal("b must be unaffected")
	}
}

func TestClientKeyForwarded(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.Header.Set("X-Forwarded-For", "9.9.9.9, 10.0.0.1")
	if got := ClientKey(r); got != "9.9.9.9" {
		t.Fatalf("ClientKey = %q", got)
	}
	r2 := httptest.NewRequest("POST", "/api/auth/login", nil)
	r2.RemoteAddr = "7.7.7.7:1234"
	if got := ClientKey(r2); got != "7.7.7.7:1234" {
		t.Fatalf("ClientKey = %q", got)
	}
	_ = time.Now()
}
