package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MARKDECK_ADDR", "")
	t.Setenv("MARKDECK_DATA", dir)
	t.Setenv("MARKDECK_BASE_URL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:8990" {
		t.Errorf("Addr = %q", cfg.Addr)
	}
	if cfg.DBPath != filepath.Join(dir, "markdeck.db") {
		t.Errorf("DBPath = %q", cfg.DBPath)
	}
	if cfg.SnapshotDir != filepath.Join(dir, "snapshots") {
		t.Errorf("SnapshotDir = %q", cfg.SnapshotDir)
	}
	if cfg.SessionTTLHours != 24*14 {
		t.Errorf("SessionTTLHours = %d", cfg.SessionTTLHours)
	}
}

func TestLoadRejectsBadAddr(t *testing.T) {
	t.Setenv("MARKDECK_ADDR", "not-an-addr")
	t.Setenv("MARKDECK_DATA", t.TempDir())
	if _, err := Load(); err == nil {
		t.Fatal("expected error for bad addr")
	}
}

func TestLoadSessionTTLBounds(t *testing.T) {
	t.Setenv("MARKDECK_DATA", t.TempDir())
	t.Setenv("MARKDECK_SESSION_TTL_HOURS", "0")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for ttl 0")
	}
	t.Setenv("MARKDECK_SESSION_TTL_HOURS", "99999")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for huge ttl")
	}
	t.Setenv("MARKDECK_SESSION_TTL_HOURS", "24")
	cfg, err := Load()
	if err != nil || cfg.SessionTTLHours != 24 {
		t.Fatalf("ttl=24 failed: %v %v", cfg, err)
	}
	_ = os.RemoveAll(t.TempDir())
}
