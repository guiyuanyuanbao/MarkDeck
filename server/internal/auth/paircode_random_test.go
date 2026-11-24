package auth

import (
	"strings"
	"testing"
)

// The old randomDigits filtered base64 bytes for ASCII digits and padded
// deterministically when short — producing the same 012345 every time.
// The fix maps entropy bytes uniformly (mod 10); assert spread + no pad.
func TestPairCodeRandomSpread(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := randomDigits(6)
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != 6 {
			t.Fatalf("len=%d", len(code))
		}
		if strings.HasPrefix(code, "012345") && code == "012345" {
			t.Fatalf("deterministic pad leaked: %s", code)
		}
		seen[code] = true
	}
	if len(seen) < 150 {
		t.Fatalf("only %d distinct codes in 200 draws — not random enough", len(seen))
	}
}
