// Package config loads MarkDeck runtime configuration from environment
// variables and command-line flags.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// Config holds all runtime settings for the markdeck server.
type Config struct {
	// Addr is the HTTP listen address, e.g. "127.0.0.1:8990".
	Addr string
	// DataDir is the directory that holds the SQLite database and snapshots.
	DataDir string
	// BaseURL is the externally reachable base URL (used in otpauth URLs and
	// export metadata). May be empty.
	BaseURL string
	// DBPath is the full path to the SQLite database file.
	DBPath string
	// SnapshotDir is where JSON snapshot files are written.
	SnapshotDir string
	// SessionTTL is how long a login session cookie stays valid.
	SessionTTLHours int
}

// Load builds a Config from MARKDECK_* environment variables, applying
// defaults and validating values.
func Load() (*Config, error) {
	cfg := &Config{
		Addr:            envOr("MARKDECK_ADDR", "127.0.0.1:8990"),
		DataDir:         envOr("MARKDECK_DATA", "data"),
		BaseURL:         os.Getenv("MARKDECK_BASE_URL"),
		SessionTTLHours: 24 * 14,
	}
	if v := os.Getenv("MARKDECK_SESSION_TTL_HOURS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 24*90 {
			return nil, fmt.Errorf("invalid MARKDECK_SESSION_TTL_HOURS %q", v)
		}
		cfg.SessionTTLHours = n
	}

	if err := cfg.ensureDataDir(); err != nil {
		return nil, err
	}
	cfg.DBPath = filepath.Join(cfg.DataDir, "markdeck.db")
	cfg.SnapshotDir = filepath.Join(cfg.DataDir, "snapshots")
	return cfg, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var addrRe = regexp.MustCompile(`^[0-9a-zA-Z.\-:\[\]]+:[0-9]{1,5}$`)

func (c *Config) ensureDataDir() error {
	// Resolve DataDir relative to CWD unless absolute.
	if !filepath.IsAbs(c.DataDir) {
		abs, err := filepath.Abs(c.DataDir)
		if err != nil {
			return err
		}
		c.DataDir = abs
	}
	if !addrRe.MatchString(c.Addr) {
		return fmt.Errorf("invalid MARKDECK_ADDR %q (expected host:port)", c.Addr)
	}
	return os.MkdirAll(c.DataDir, 0o700)
}
