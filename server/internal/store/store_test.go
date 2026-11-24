package store

import (
	"fmt"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func seed(s *Store, parent, typ, title, url string) *Bookmark {
	b := &Bookmark{ParentID: parent, Type: typ, Title: title, URL: url, DeviceID: "test"}
	out, err := s.Create(b, nil)
	if err != nil {
		panic(err)
	}
	return out
}

func TestRevisionMonotonic(t *testing.T) {
	s := newTestStore(t)
	last := int64(0)
	for i := 0; i < 20; i++ {
		b := seed(s, "", "url", fmt.Sprintf("bm %d", i), fmt.Sprintf("https://x/%d", i))
		if b.Revision <= last {
			t.Fatalf("revision not monotonic: %d after %d", b.Revision, last)
		}
		last = b.Revision
	}
}

func TestCRUDAndTree(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	_ = seed(s, f.ID, "url", "Go", "https://go.dev")
	kids, err := s.Children(f.ID)
	if err != nil || len(kids) != 1 {
		t.Fatalf("children = %v, %v", kids, err)
	}
	// soft delete folder -> child still rows but subtree returned
	ids, err := s.DeleteSoft(f.ID, Now(), "test")
	if err != nil || len(ids) != 2 {
		t.Fatalf("subtree ids = %v err=%v", ids, err)
	}
	if _, err := s.Children(f.ID); len(kids) != 1 {
		_ = err
	}
	trash, _ := s.Trash()
	if len(trash) != 2 {
		t.Fatalf("trash = %d", len(trash))
	}
	// restore child: parent deleted -> re-attach root
	b, err := s.Restore(kids[0].ID, Now(), "test")
	if err != nil || b.ParentID != "" {
		t.Fatalf("restore: %+v err=%v", b, err)
	}
}

func TestLWWConflict(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "orig", "https://a")

	// helper: run one batch update op through the reconcile apply path
	apply := func(id, title string, updatedAt int64, device string, observed int64) BatchResult {
		res := s.ApplyBatch([]BatchOp{{
			ID: id, Op: "update", Title: &title, UpdatedAt: updatedAt,
			DeviceID: device, ObservedRevision: observed,
		}}, Now())
		if len(res) != 1 {
			t.Fatalf("batch = %d results", len(res))
		}
		return res[0]
	}

	older := b.UpdatedAt - 10
	if res := apply(b.ID, "older", older, "aaa", b.Revision); res.Win {
		t.Fatalf("older should lose: %+v", res)
	}
	cur, _ := s.Get(b.ID)
	if cur.Title != "orig" {
		t.Fatalf("title changed by losing write: %q", cur.Title)
	}

	newer := b.UpdatedAt + 10
	res := apply(b.ID, "newer", newer, "bbb", b.Revision)
	if !res.Win || res.State.Title != "newer" {
		t.Fatalf("newer should win: %+v", res)
	}
	newRev := res.State.Revision

	// tie (same UpdatedAt as current winner) from a DIFFERENT device with a
	// STALE baseline (observed < current revision): the concurrent write the
	// client never saw wins — identical rule to the old per-op protocol.
	tie := newer
	if res := apply(b.ID, "tie-b", tie, "zzz", b.Revision); res.Win {
		t.Fatalf("stale-baseline tie must lose against unseen concurrent write: %+v", res)
	}
	cur, _ = s.Get(b.ID)
	if cur.Title != "newer" || cur.Revision != newRev {
		t.Fatalf("row must be untouched: %+v", cur)
	}
	// same tie but authored against the CURRENT revision: legitimate
	// follow-up edit, wins
	if res := apply(b.ID, "chain-b", tie, "zzz", newRev); !res.Win || res.State.Title != "chain-b" {
		t.Fatalf("current-baseline follow-up must win tie: %+v", res)
	}
}

func TestApplyBatchIdempotentReplay(t *testing.T) {
	s := newTestStore(t)
	// a create for an already-existing row degrades to an idempotent update
	// (half-applied batch replay) instead of erroring on the PK collision
	f := seed(s, "", "folder", "f", "")
	res := s.ApplyBatch([]BatchOp{{
		ID: f.ID, Op: "create", Type: "folder", Title: strptr("f-renamed"),
		UpdatedAt: f.UpdatedAt + 5, DeviceID: "d1", ObservedRevision: f.Revision,
	}}, Now())
	if !res[0].Win {
		t.Fatalf("replay-create must win via LWW: %+v", res[0])
	}
	cur, _ := s.Get(f.ID)
	if cur.Title != "f-renamed" {
		t.Fatalf("replay must merge content: %+v", cur)
	}
	// a create with a truly new id still inserts
	res = s.ApplyBatch([]BatchOp{{
		ID: "bm-new", Op: "create", Type: "url", ParentID: &f.ID,
		Title: strptr("ok"), URL: strptr("https://ok"), UpdatedAt: 100, DeviceID: "d1",
	}}, Now())
	if !res[0].Win || res[0].Error != "" {
		t.Fatalf("fresh create must win: %+v", res[0])
	}
}

func TestApplyBatchParentOrdering(t *testing.T) {
	s := newTestStore(t)
	// folder first, child after — parents created earlier in the batch pass
	// validation inside the tx
	res := s.ApplyBatch([]BatchOp{
		{ID: "f1", Op: "create", Type: "folder", Title: strptr("F1"), UpdatedAt: 100, DeviceID: "d"},
		{ID: "f2", Op: "create", Type: "folder", ParentID: strptr("f1"), Title: strptr("F2"), UpdatedAt: 100, DeviceID: "d"},
		{ID: "b1", Op: "create", Type: "url", ParentID: strptr("f2"), Title: strptr("B"), URL: strptr("https://b"), UpdatedAt: 100, DeviceID: "d"},
	}, Now())
	for i, r := range res {
		if !r.Win {
			t.Fatalf("op %d failed: %+v", i, r)
		}
	}
	b, err := s.Get("b1")
	if err != nil || b.ParentID != "f2" {
		t.Fatalf("nested create lost: %+v err=%v", b, err)
	}
	// parent AFTER child must fail the child (not silently orphan it)
	res = s.ApplyBatch([]BatchOp{
		{ID: "b2", Op: "create", Type: "url", ParentID: strptr("nope"), Title: strptr("X"), URL: strptr("https://x"), UpdatedAt: 100, DeviceID: "d"},
	}, Now())
	if res[0].Win || res[0].Error == "" {
		t.Fatalf("unknown parent must error: %+v", res[0])
	}
}

func TestApplyBatchDeleteSubtree(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "F", "")
	k := seed(s, f.ID, "url", "K", "https://k")
	res := s.ApplyBatch([]BatchOp{{ID: f.ID, Op: "delete", UpdatedAt: 500, DeviceID: "d"}}, Now())
	if !res[0].Win {
		t.Fatalf("delete failed: %+v", res[0])
	}
	kid, _ := s.Get(k.ID)
	if kid.DeletedAt == 0 {
		t.Fatal("subtree child must be tombstoned with the folder")
	}
	// deleting an already-absent row is a win (idempotent)
	res = s.ApplyBatch([]BatchOp{{ID: "ghost", Op: "delete", UpdatedAt: 500, DeviceID: "d"}}, Now())
	if !res[0].Win {
		t.Fatalf("idempotent delete must win: %+v", res[0])
	}
}

func TestMoveIntoOwnSubtreeRejected(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "f1", "")
	f2 := seed(s, f1.ID, "folder", "f2", "")
	if _, err := s.Move(f1.ID, f2.ID, 1, Now(), "d"); err == nil {
		t.Fatal("move into own subtree must fail")
	}
	if _, err := s.Move(f2.ID, "", 1, Now(), "d"); err != nil {
		t.Fatalf("normal move failed: %v", err)
	}
}

func TestPurgeKeepsTombstone(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "gone", "https://g")
	if _, err := s.DeleteSoft(b.ID, Now(), "d"); err != nil {
		t.Fatal(err)
	}
	if err := s.Purge(b.ID, Now(), "d"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Purged || got.Title != "" || got.URL != "" || got.DeletedAt == 0 {
		t.Fatalf("purged row wrong: %+v", got)
	}
}

func TestTagsAndSearch(t *testing.T) {
	s := newTestStore(t)
	b1 := seed(s, "", "url", "The Go Programming Language", "https://go.dev/doc")
	b2 := seed(s, "", "url", "Go by Example 中文版", "https://gobyexample-cn.github.io")
	_ = seed(s, "", "url", "Rust book", "https://doc.rust-lang.org")

	if _, err := s.SetTags(b1.ID, []string{"Go Lang", "docs"}, "d"); err != nil {
		t.Fatal(err)
	}
	tags, _ := s.ListTags()
	if len(tags) != 2 || tags[0].Tag != "docs" || tags[0].Count != 1 {
		t.Fatalf("tags = %+v", tags)
	}
	// rename merges: bookmark had [docs, go lang] -> [docs, golang]
	if n, err := s.RenameTag("go lang", "golang"); err != nil || n != 1 {
		t.Fatalf("rename: n=%d err=%v", n, err)
	}
	got, _ := s.Get(b1.ID)
	if len(got.Tags) != 2 || got.Tags[0] != "docs" || got.Tags[1] != "golang" {
		t.Fatalf("merged tags = %v", got.Tags)
	}
	// delete tag removes it everywhere
	if n, err := s.DeleteTag("docs"); err != nil || n != 1 {
		t.Fatalf("delete tag: n=%d err=%v", n, err)
	}
	got, _ = s.Get(b1.ID)
	if len(got.Tags) != 1 || got.Tags[0] != "golang" {
		t.Fatalf("after delete: %v", got.Tags)
	}
	// FTS finds substring/CJK
	res, err := s.Search("中文版", 10)
	if err != nil || len(res) != 1 || res[0].ID != b2.ID {
		t.Fatalf("cjk search = %v err=%v", res, err)
	}
	res, err = s.Search("go.dev", 10)
	if err != nil || len(res) != 1 {
		t.Fatalf("url search = %v err=%v", res, err)
	}
	// short query falls back to LIKE
	res, err = s.Search("Rust", 10)
	if err != nil || len(res) != 1 {
		t.Fatalf("like search = %v err=%v", res, err)
	}
}

func strptr(s string) *string { return &s }

func TestApplyBatchReconcileRoundtrip(t *testing.T) {
	// mirrors the reconciler's full cycle: pull tree → apply local edits →
	// tree reflects them and head advances monotonically
	s := newTestStore(t)
	before, _ := s.MaxRevision()
	f := seed(s, "", "folder", "Work", "")
	base := f.Revision
	if base < before {
		t.Fatalf("revision went backwards: %d < %d", base, before)
	}
	res := s.ApplyBatch([]BatchOp{{
		ID: f.ID, Op: "update", Title: strptr("Work2"),
		UpdatedAt: f.UpdatedAt + 5, DeviceID: "ext-1", ObservedRevision: f.Revision,
	}}, Now())
	if !res[0].Win {
		t.Fatalf("update lost: %+v", res[0])
	}
	after, _ := s.MaxRevision()
	if after <= before {
		t.Fatalf("head did not advance: %d -> %d", before, after)
	}
}
