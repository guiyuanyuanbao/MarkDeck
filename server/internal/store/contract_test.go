package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Golden contract tests: the JSON wire shapes of BatchOp and Bookmark are
// consumed by two hand-mirrored clients (extension reconcile.ts ServerOp /
// ServerNode, web client.ts Bookmark). Any field/tag change here must be
// reflected in both clients — these tests fail until it is, and the
// extension suite re-asserts the same fixtures (tests/protocol/*.golden.json)
// so a one-sided change cannot slip through CI.

func goldenPath(name string) string { return filepath.Join("testdata", name) }

func loadGolden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(goldenPath(name))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return b
}

// TestBatchOpGoldenContract round-trips the golden fixture through
// BatchOp and re-marshals it, proving the struct's tags still parse and
// emit exactly the documented wire shape.
func TestBatchOpGoldenContract(t *testing.T) {
	raw := loadGolden(t, "batchops.golden.json")
	var ops []BatchOp
	if err := json.Unmarshal(raw, &ops); err != nil {
		t.Fatalf("golden fixture no longer decodes into store.BatchOp: %v", err)
	}
	if len(ops) != 3 {
		t.Fatalf("expected 3 ops, got %d", len(ops))
	}
	// spot-check pointer/optional semantics the reconciler relies on
	if ops[0].Position == nil || *ops[0].Position != 2.5 {
		t.Errorf("op0 position: want 2.5, got %v", ops[0].Position)
	}
	if ops[1].Undelete != true {
		t.Errorf("op1 undelete: want true")
	}
	if ops[2].ParentID != nil || ops[2].Title != nil {
		t.Errorf("op2 delete op must not carry parent/title")
	}
	out, err := json.Marshal(ops)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var a, b any
	json.Unmarshal(raw, &a)
	json.Unmarshal(out, &b)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Errorf("BatchOp re-marshal diverged from golden wire shape:\n golden: %s\n   live: %s", ja, jb)
	}
}

// TestBookmarkGoldenContract pins the Bookmark JSON shape shared with the
// web client and the /api/sync/tree payload consumed by the extension.
func TestBookmarkGoldenContract(t *testing.T) {
	raw := loadGolden(t, "bookmark.golden.json")
	var rows []Bookmark
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("golden fixture no longer decodes into store.Bookmark: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	if rows[0].DeletedAt != 1700000100 || rows[0].Revision != 12 {
		t.Errorf("row0 fields not parsed as expected: %+v", rows[0])
	}
	if rows[1].URL != "" || rows[1].DeviceID != "" {
		t.Errorf("omitempty fields should decode to zero values, got url=%q device=%q", rows[1].URL, rows[1].DeviceID)
	}
	out, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var a, b any
	json.Unmarshal(raw, &a)
	json.Unmarshal(out, &b)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Errorf("Bookmark re-marshal diverged from golden wire shape:\n golden: %s\n   live: %s", ja, jb)
	}
}
