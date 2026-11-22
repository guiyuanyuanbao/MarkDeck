// Copyright 2026 The Libc Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package libc // import "modernc.org/libc"

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
	sysdirent "modernc.org/libc/dirent"
	"modernc.org/libc/netdb"
	"modernc.org/libc/sys/socket"
)

// TestSeekdirIllumos checks that seekdir returns to a telldir position and
// that seekdir(dirp, 0), which is what <dirent.h> makes of rewinddir, starts
// over.
func TestSeekdirIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	dir := t.TempDir()
	for _, v := range []string{"a", "b", "c", "d"} {
		if err := os.WriteFile(filepath.Join(dir, v), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	cname, err := CString(dir)
	if err != nil {
		t.Fatal(err)
	}

	defer Xfree(tls, cname)

	d := Xopendir(tls, cname)
	if d == 0 {
		t.Fatalf("opendir: errno %v", *(*int32)(unsafe.Pointer(X___errno(tls))))
	}

	defer Xclosedir(tls, d)

	next := func() string {
		ent := Xreaddir(tls, d)
		if ent == 0 {
			t.Fatal("unexpected end of directory")
		}

		return GoString(ent + unsafe.Offsetof(sysdirent.Dirent{}.Fd_name))
	}
	first := next()
	pos := Xtelldir(tls, d)
	if pos < 0 {
		t.Fatalf("telldir: errno %v", *(*int32)(unsafe.Pointer(X___errno(tls))))
	}

	second := next()
	next()
	Xseekdir(tls, d, pos)
	if g, e := next(), second; g != e {
		t.Fatalf("after seekdir(telldir): got %q, want %q", g, e)
	}

	Xseekdir(tls, d, 0)
	if g, e := next(), first; g != e {
		t.Fatalf("after seekdir(0): got %q, want %q", g, e)
	}
}

func TestInetNtoaIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	var a tin_addr
	a.FS_un.FS_un_b.Fs_b1 = 192
	a.FS_un.FS_un_b.Fs_b2 = 0
	a.FS_un.FS_un_b.Fs_b3 = 2
	a.FS_un.FS_un_b.Fs_b4 = 33
	if g, e := GoString(Xinet_ntoa(tls, a)), "192.0.2.33"; g != e {
		t.Fatalf("got %q, want %q", g, e)
	}
}

func TestMkstempIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	template := filepath.Join(t.TempDir(), "fooXXXXXX")
	var names []string
	for i := 0; i < 2; i++ {
		s, err := CString(template)
		if err != nil {
			t.Fatal(err)
		}

		defer Xfree(tls, s)

		fd := Xmkstemp(tls, s)
		if fd < 0 {
			t.Fatalf("mkstemp: errno %v", *(*int32)(unsafe.Pointer(X___errno(tls))))
		}

		Xclose(tls, fd)
		name := GoString(s)
		if len(name) != len(template) || name[:len(name)-6] != template[:len(template)-6] || name == template {
			t.Fatalf("mkstemp(%q) produced %q", template, name)
		}

		if _, err := os.Stat(name); err != nil {
			t.Fatal(err)
		}

		names = append(names, name)
	}
	if names[0] == names[1] {
		t.Fatalf("mkstemp produced %q twice", names[0])
	}
}

// TestGetaddrinfoIllumos checks getaddrinfo, getnameinfo and gai_strerror
// against the illumos values of struct addrinfo, AF_*, SOCK_*, AI_*, NI_* and
// EAI_*.
func TestGetaddrinfoIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	cstr := func(s string) uintptr {
		p, err := CString(s)
		if err != nil {
			t.Fatal(err)
		}

		t.Cleanup(func() { Xfree(tls, p) })
		return p
	}
	hints := Xcalloc(tls, 1, Tsize_t(unsafe.Sizeof(netdb.Addrinfo{})))
	res := Xcalloc(tls, 1, Tsize_t(unsafe.Sizeof(uintptr(0))))
	host := Xcalloc(tls, 1, netdb.NI_MAXHOST)
	serv := Xcalloc(tls, 1, netdb.NI_MAXSERV)

	defer Xfree(tls, hints)
	defer Xfree(tls, res)
	defer Xfree(tls, host)
	defer Xfree(tls, serv)

	h := (*netdb.Addrinfo)(unsafe.Pointer(hints))
	for _, v := range []struct {
		family int32
		addr   string
	}{
		{socket.AF_INET, "127.0.0.1"},
		{socket.AF_INET6, "::1"},
	} {
		*h = netdb.Addrinfo{}
		h.Fai_flags = netdb.AI_NUMERICHOST | netdb.AI_NUMERICSERV
		h.Fai_family = v.family
		h.Fai_socktype = socket.SOCK_STREAM
		if rc := Xgetaddrinfo(tls, cstr(v.addr), cstr("8080"), hints, res); rc != 0 {
			t.Fatalf("getaddrinfo(%q): %v %s", v.addr, rc, GoString(Xgai_strerror(tls, rc)))
		}

		ai := *(*uintptr)(unsafe.Pointer(res))
		a := (*netdb.Addrinfo)(unsafe.Pointer(ai))
		if g, e := a.Fai_family, v.family; g != e {
			t.Errorf("%s: ai_family %v, want %v", v.addr, g, e)
		}
		if g, e := a.Fai_socktype, int32(socket.SOCK_STREAM); g != e {
			t.Errorf("%s: ai_socktype %v, want %v", v.addr, g, e)
		}
		if g, e := a.Fai_protocol, int32(6); g != e { // IPPROTO_TCP
			t.Errorf("%s: ai_protocol %v, want %v", v.addr, g, e)
		}

		if rc := Xgetnameinfo(tls, a.Fai_addr, a.Fai_addrlen, host, netdb.NI_MAXHOST, serv, netdb.NI_MAXSERV, netdb.NI_NUMERICHOST|netdb.NI_NUMERICSERV); rc != 0 {
			t.Fatalf("getnameinfo(%q): %v %s", v.addr, rc, GoString(Xgai_strerror(tls, rc)))
		}

		if g, e := GoString(host)+" "+GoString(serv), v.addr+" 8080"; g != e {
			t.Errorf("getnameinfo: got %q, want %q", g, e)
		}

		if rc := Xgetnameinfo(tls, a.Fai_addr, a.Fai_addrlen, host, 1, 0, 0, netdb.NI_NUMERICHOST); rc != netdb.EAI_OVERFLOW {
			t.Errorf("getnameinfo(%q) with a short buffer: %v, want EAI_OVERFLOW (%v)", v.addr, rc, netdb.EAI_OVERFLOW)
		}

		Xfreeaddrinfo(tls, ai)
	}

	h.Fai_family = 12345
	if rc := Xgetaddrinfo(tls, cstr("127.0.0.1"), 0, hints, res); rc != netdb.EAI_FAMILY {
		t.Errorf("getaddrinfo with a bad family: %v, want EAI_FAMILY (%v)", rc, netdb.EAI_FAMILY)
	}

	if s := GoString(Xgai_strerror(tls, netdb.EAI_NONAME)); s == "" {
		t.Error("gai_strerror(EAI_NONAME) is empty")
	}
}

func TestInetPtonNtopIllumos(t *testing.T) {
	tls := NewTLS()

	defer tls.Close()

	buf := Xcalloc(tls, 1, 64)
	addr := Xcalloc(tls, 1, 16)

	defer Xfree(tls, buf)
	defer Xfree(tls, addr)

	for _, v := range []struct {
		family int32
		s      string
	}{
		{socket.AF_INET, "192.0.2.33"},
		{socket.AF_INET6, "2001:db8::1"},
	} {
		s, err := CString(v.s)
		if err != nil {
			t.Fatal(err)
		}

		rc := Xinet_pton(tls, v.family, s, addr)
		Xfree(tls, s)
		if rc != 1 {
			t.Fatalf("inet_pton(%q): %v", v.s, rc)
		}

		if Xinet_ntop(tls, v.family, addr, buf, 64) == 0 {
			t.Fatalf("inet_ntop(%q) failed", v.s)
		}

		if g, e := GoString(buf), v.s; g != e {
			t.Errorf("got %q, want %q", g, e)
		}
	}
}

// TestAbortIllumos checks that abort kills the process by SIGABRT, not by the
// Go runtime's crash trace and exit status 2.
func TestAbortIllumos(t *testing.T) {
	if os.Getenv("LIBC_TEST_ABORT") != "" {
		unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{}) // No core file.
		Xabort(NewTLS())
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestAbortIllumos$")
	cmd.Env = append(os.Environ(), "LIBC_TEST_ABORT=1")
	out, err := cmd.CombinedOutput()
	if cmd.ProcessState == nil {
		t.Fatal(err)
	}

	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); !ok || !ws.Signaled() || ws.Signal() != syscall.SIGABRT {
		t.Fatalf("%v, want killed by SIGABRT\n%s", cmd.ProcessState, out)
	}

	if strings.Contains(string(out), "goroutine") {
		t.Fatalf("Go runtime trace in the output:\n%s", out)
	}
}
