package favicon

import (
	"testing"
)

func TestSanitizeHost(t *testing.T) {
	cases := map[string]string{
		"github.com":                   "github.com",
		"  GitHub.COM  ":               "github.com",
		"https://news.ycombinator.com": "news.ycombinator.com",
		"example.com/path?query=1":     "example.com",
		"example.com:8080":             "example.com",
		"":                             "",
		"<evil>":                       "",
	}
	for in, want := range cases {
		if got := sanitizeHost(in); got != want {
			t.Errorf("sanitizeHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLooksLikeImage(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0, 0, 0, 0}
	jpg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	ico := []byte{0x00, 0x00, 0x01, 0x00, 0x00, 0x00}
	svg := []byte("<svg x")
	html := []byte("<html><body>")
	if !looksLikeImage(png) || !looksLikeImage(jpg) || !looksLikeImage(ico) || !looksLikeImage(svg) {
		t.Fatal("valid image rejected")
	}
	if looksLikeImage(html) || looksLikeImage([]byte{1, 2, 3}) {
		t.Fatal("non-image accepted")
	}
}
