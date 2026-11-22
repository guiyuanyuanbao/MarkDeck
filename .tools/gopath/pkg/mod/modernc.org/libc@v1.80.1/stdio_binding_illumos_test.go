// Copyright 2026 The Libc Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package libc // import "modernc.org/libc"

import (
	"testing"
	"unsafe"

	"modernc.org/libc/unistd"
)

// On illumos C stdin, stdout and stderr are &__iob[0], &__iob[1] and
// &__iob[2], see stderr_binding_test.go for why this is worth a test.
func TestStdioBindingIllumos(t *testing.T) {
	for _, v := range []struct {
		name string
		p    uintptr
		want int32
	}{
		{"Xstdin", Xstdin, unistd.STDIN_FILENO},
		{"Xstdout", Xstdout, unistd.STDOUT_FILENO},
		{"Xstderr", Xstderr, unistd.STDERR_FILENO},
	} {
		if g, e := v.p, uintptr(unsafe.Pointer(&X__iob[v.want])); g != e {
			t.Errorf("%s is %#x, want &X__iob[%d] = %#x", v.name, g, v.want, e)
		}

		if got := file(v.p).fd(); got != v.want {
			t.Errorf("%s is bound to fd %v, want %v", v.name, got, v.want)
		}
	}
}
