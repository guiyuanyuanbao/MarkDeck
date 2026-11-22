// Copyright 2026 The Libc Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package libc // import "modernc.org/libc"

import (
	"strings"
	"testing"
)

// TestCtypeIllumos checks the <ctype.h> functions illumos has no macros for
// against the C locale, from EOF through 255.
func TestCtypeIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
	for _, v := range []struct {
		name string
		f    func(*TLS, int32) int32
		in   func(c int32) bool
	}{
		{"isblank", Xisblank, func(c int32) bool { return c == ' ' || c == '\t' }},
		{"iscntrl", Xiscntrl, func(c int32) bool { return c >= 0 && c < 0x20 || c == 0x7f }},
		{"isgraph", Xisgraph, func(c int32) bool { return c > ' ' && c < 0x7f }},
		{"ispunct", Xispunct, func(c int32) bool { return c > 0 && c < 0x80 && strings.ContainsRune(punct, rune(c)) }},
		{"isspace", Xisspace, func(c int32) bool { return c > 0 && c < 0x80 && strings.ContainsRune(" \t\n\v\f\r", rune(c)) }},
	} {
		for c := int32(-1); c < 256; c++ {
			if g, e := v.f(tls, c) != 0, v.in(c); g != e {
				t.Errorf("%s(%d): got %v, expected %v", v.name, c, g, e)
			}
		}
	}
}
