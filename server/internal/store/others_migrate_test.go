package store

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestOthersMigrationMergeDedupe covers migration 0003's Go-side merge:
// per-device holders fold into the canonical holder with URL dedupe and
// same-title folder collapse; holders are hard-deleted.
func TestOthersMigrationMergeDedupe(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// fresh Open already ran the migration: canonical holder must exist
	if _, err := s.Get(canonicalOthersID); err != nil {
		t.Fatalf("canonical holder missing after Open: %v", err)
	}

	// simulate legacy per-device holders (the merge runs on Open only, so
	// create them and re-run MigrateOthersHolders directly)
	holderA := &Bookmark{ID: "others-devA", Type: "folder", Title: "其他书签", DeviceID: "x", UpdatedAt: 1, CreatedAt: 1}
	holderB := &Bookmark{ID: "others-devB", Type: "folder", Title: "其他书签", DeviceID: "y", UpdatedAt: 1, CreatedAt: 1}
	for _, h := range []*Bookmark{holderA, holderB} {
		if _, err := s.Create(h, nil); err != nil {
			t.Fatal(err)
		}
	}
	mk := func(parent, title, url string) *Bookmark {
		b, err := s.Create(&Bookmark{ParentID: parent, Type: "url", Title: title, URL: url, DeviceID: "x", UpdatedAt: 1, CreatedAt: 1}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	mkf := func(parent, title string) *Bookmark {
		b, err := s.Create(&Bookmark{ParentID: parent, Type: "folder", Title: title, DeviceID: "x", UpdatedAt: 1, CreatedAt: 1}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	mk(holderA.ID, "go.dev", "https://go.dev/")
	mk(holderB.ID, "go.dev", "https://go.dev")   // same URL, slash-divergent
	mk(holderB.ID, "go.dev", "https://go.dev/x") // different URL: survives
	folderA := mkf(holderA.ID, "Docs")
	mk(folderA.ID, "spec", "https://spec.test")
	folderB := mkf(holderB.ID, "Docs") // same-name folder: collapses
	mk(folderB.ID, "draft", "https://draft.test")

	if err := s.MigrateOthersHolders(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// holders hard-deleted
	if _, err := s.Get(holderA.ID); err != ErrNotFound {
		t.Fatalf("holderA must be gone: %v", err)
	}
	if _, err := s.Get(holderB.ID); err != ErrNotFound {
		t.Fatalf("holderB must be gone: %v", err)
	}

	// canonical holder now holds: go.dev (deduped), go.dev/x, Docs (collapsed)
	kids, err := s.Children(canonicalOthersID)
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	var folders []string
	for _, k := range kids {
		if k.Type == "url" {
			urls = append(urls, k.URL)
		} else {
			folders = append(folders, k.Title)
		}
	}
	if len(urls) != 2 {
		t.Fatalf("canonical holder urls = %v (want 2: dedupe by normalized URL)", urls)
	}
	hasSlashless, hasX := false, false
	for _, u := range urls {
		if u == "https://go.dev/" {
			hasSlashless = true
		}
		if u == "https://go.dev/x" {
			hasX = true
		}
	}
	if !hasSlashless || !hasX {
		t.Fatalf("expected both distinct urls under holder, got %v", urls)
	}
	// the duplicate copy is in the trash, not purged
	trash, _ := s.Trash()
	foundDup := false
	for _, tr := range trash {
		if tr.URL == "https://go.dev" || tr.URL == "https://go.dev/" {
			foundDup = true
		}
	}
	if !foundDup {
		t.Fatalf("duplicate copy must be trashed (recoverable), trash=%v", trash)
	}
	if len(folders) != 1 || folders[0] != "Docs" {
		t.Fatalf("same-name folders must collapse: %v", folders)
	}
	docs := kids[0]
	for _, k := range kids {
		if k.Title == "Docs" {
			docs = k
		}
	}
	dkids, _ := s.Children(docs.ID)
	if len(dkids) != 2 {
		t.Fatalf("collapsed Docs must hold both children, got %d", len(dkids))
	}

	// re-running is a no-op (idempotent)
	if err := s.MigrateOthersHolders(); err != nil {
		t.Fatalf("second run must be a no-op, got %v", err)
	}
	kids2, _ := s.Children(canonicalOthersID)
	if len(kids2) != len(kids) {
		t.Fatalf("second merge duplicated content: %d -> %d", len(kids), len(kids2))
	}
}

// TestMigrationCreatesCanonicalHolderOnLegacyDB verifies migration 0003
// runs against a store whose rows were created before 0003 (no
// schema_migrations entry) — the canonical row appears, revisions bump.
func TestMigrationCreatesCanonicalHolderOnLegacyDB(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	// build a "legacy" DB manually: delete the canonical row + its
	// schema_migrations entry, then re-open (migrate() re-applies 0003).
	// All DELETEs must run BEFORE Close (closed DB rejects Exec).
	if _, err := s.DB.Exec(`DELETE FROM schema_migrations WHERE version LIKE '0003%'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`DELETE FROM bookmarks WHERE id = ?`, canonicalOthersID); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2, err := Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	b, err := s2.Get(canonicalOthersID)
	if err != nil {
		t.Fatalf("canonical holder must be re-created: %v", err)
	}
	if b.Title != "其他书签" || b.Type != "folder" || b.ParentID != "" {
		t.Fatalf("canonical holder shape wrong: %+v", b)
	}
	if !strings.HasPrefix(b.ID, "md-") {
		t.Fatalf("canonical id must be the fixed md-others id")
	}
}
