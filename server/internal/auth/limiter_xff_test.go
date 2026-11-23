package auth

import (
	"net/http/httptest"
	"testing"
)

// Without MARKDECK_TRUST_PROXY a direct client can spoof X-Forwarded-For to
// rotate throttle keys; the limiter must key on the socket address instead.
func TestLimiterXFFSpoofBlockedByDefault(t *testing.T) {
	trustProxy = false
	l := NewLimiter(3)
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.Header.Set("X-Forwarded-For", "10.1.1."+string(rune('a'+i))+":9")
		key := ClientKey(r)
		if i > 0 && key == "10.1.1.a:9" {
			t.Fatalf("attempt %d reused spoofed key %q", i, key)
		}
		l.Fail(key)
	}
	// the spoofed keys never accumulated failures
	if !l.Allow("10.1.1.a:9") {
		t.Fatal("spoofed key must not have been throttled")
	}
}
