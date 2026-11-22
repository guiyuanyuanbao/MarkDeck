// Copyright 2026 The Libc Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package libc // import "modernc.org/libc"

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"unsafe"

	"modernc.org/libc/unistd"
)

// TestStdioBindingOpenBSD80 checks that the OpenBSD 8.0 stream objects
// __stdin, __stdout and __stderr, whose addresses <stdio.h> uses as stdin,
// stdout and stderr, are the same streams as __sF[0], __sF[1], __sF[2] and
// Xstdin, Xstdout, Xstderr.
func TestStdioBindingOpenBSD80(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	for _, v := range []struct {
		name string
		p    uintptr
		sF   uintptr
		x    uintptr
		fd   int32
	}{
		{"__stdin", uintptr(unsafe.Pointer(&X__stdin)), uintptr(unsafe.Pointer(&X__sF[0])), Xstdin, unistd.STDIN_FILENO},
		{"__stdout", uintptr(unsafe.Pointer(&X__stdout)), uintptr(unsafe.Pointer(&X__sF[1])), Xstdout, unistd.STDOUT_FILENO},
		{"__stderr", uintptr(unsafe.Pointer(&X__stderr)), uintptr(unsafe.Pointer(&X__sF[2])), Xstderr, unistd.STDERR_FILENO},
	} {
		if g, e := uintptr(file(v.p).sF()), v.sF; g != e {
			t.Errorf("%s maps to %#x, want __sF at %#x", v.name, g, e)
		}

		if g, e := v.x, v.sF; g != e {
			t.Errorf("X%s is %#x, want __sF at %#x", strings.TrimPrefix(v.name, "__"), g, e)
		}

		if g, e := Xfileno(tls, v.p), v.fd; g != e {
			t.Errorf("fileno(%s) = %v, want %v", v.name, g, e)
		}
	}

	// The error indicator set through one spelling shows through the other.
	old := X__sF[2]

	defer func() { X__sF[2] = old }()

	file(uintptr(unsafe.Pointer(&X__stderr))).setErr()
	if Xferror(tls, uintptr(unsafe.Pointer(&X__sF[2]))) == 0 {
		t.Error("ferror(&__sF[2]) = 0 after setting the error indicator of __stderr")
	}
}

// TestStdioWriteOpenBSD80 checks that fputs and fprintf through the addresses
// of __stdout and __stderr write to file descriptors 1 and 2.
func TestStdioWriteOpenBSD80(t *testing.T) {
	if os.Getenv("LIBC_TEST_STDIO_WRITE") != "" {
		tls := NewTLS()
		out, err := CString("<stdout>\n")
		if err != nil {
			os.Exit(2)
		}

		Xfputs(tls, out, uintptr(unsafe.Pointer(&X__stdout)))
		e, err := CString("<stderr>\n")
		if err != nil {
			os.Exit(2)
		}

		Xfprintf(tls, uintptr(unsafe.Pointer(&X__stderr)), e, 0)
		os.Exit(0)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestStdioWriteOpenBSD80$")
	cmd.Env = append(os.Environ(), "LIBC_TEST_STDIO_WRITE=1")
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("%v\nstdout: %q\nstderr: %q", err, stdout.String(), stderr.String())
	}

	if g, e := stdout.String(), "<stdout>\n"; g != e {
		t.Errorf("stdout: got %q, want %q", g, e)
	}

	if g, e := stderr.String(), "<stderr>\n"; g != e {
		t.Errorf("stderr: got %q, want %q", g, e)
	}
}
