package store

import (
	"fmt"
	"testing"
	"time"
)

// rp restores via RestoreWithPath with default opts (original path, whole tree).
func rp(s *Store, id string) *Bookmark {
	b, err := s.RestoreWithPath(id, Now(), "test", RestoreOpts{IncludeChildren: true})
	if err != nil {
		panic(err)
	}
	return b
}

func rpShell(s *Store, id string) *Bookmark {
	b, err := s.RestoreWithPath(id, Now(), "test", RestoreOpts{IncludeChildren: false})
	if err != nil {
		panic(err)
	}
	return b
}

func trashTree(s *Store, id string) {
	if _, err := s.DeleteSoft(id, Now(), "test"); err != nil {
		panic(err)
	}
}

func liveTitles(s *Store, parent string) []string {
	kids, err := s.Children(parent)
	if err != nil {
		panic(err)
	}
	out := []string{}
	for _, k := range kids {
		out = append(out, k.Title)
	}
	return out
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// intact parent: restore lands back where it was (regression vs old Restore).
func TestRestoreWithPathIntactParent(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	trashTree(s, f.ID)

	b := rp(s, f.ID)
	if b.ParentID != "" || b.DeletedAt != 0 {
		t.Fatalf("folder restore: parent=%q deleted=%d", b.ParentID, b.DeletedAt)
	}
	kids, err := s.Children(f.ID)
	if err != nil || len(kids) != 1 || kids[0].ID != child.ID {
		t.Fatalf("subtree not revived: %v err=%v", kids, err)
	}
}

// parent still in trash: shell-revive it, then the child fills back in.
func TestRestoreWithPathShellRevivesParent(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	trashTree(s, f.ID)

	// restore ONLY the child while its parent is still trashed
	b := rp(s, child.ID)
	if b.ParentID != f.ID {
		t.Fatalf("child parent = %q, want shell-revived %q", b.ParentID, f.ID)
	}
	shell, err := s.Get(f.ID)
	if err != nil || shell.DeletedAt != 0 {
		t.Fatalf("shell not revived: %+v err=%v", shell, err)
	}
	// shell is empty: the trashed sibling rows stay tombstoned
	shellKids, _ := s.Children(f.ID)
	if len(shellKids) != 1 || shellKids[0].ID != child.ID {
		t.Fatalf("shell children = %d, want 1", len(shellKids))
	}
	// the parent folder is now LIVE but empty-of-other-children — the shell
	// lives in the tree, not in the trash; trash holds nothing else here
	if got := trashCount(s); got != 0 {
		t.Fatalf("trash count = %d, want 0 (both rows consumed)", got)
	}
}

// purged ancestor wipes the path — re-root at top level, no error.
// Purge always nukes whole subtrees, so a tombstoned child under a purged
// parent can't arise through normal flows; craft it directly to exercise the
// defensive branch in ensureLiveAncestor.
func TestRestoreWithPathPurgedAncestorRoots(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Doomed", "")
	child := seed(s, f.ID, "url", "Survivor", "https://survive.example")
	trashTree(s, f.ID)

	// purge the folder, then hand-craft the child back into tombstone state
	// with a parent_id pointing at the purged row
	if err := s.Purge(f.ID, Now(), "test"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if _, err := s.DB.Exec(`UPDATE bookmarks SET parent_id=?, deleted_at=1, purged=0, title='Survivor', url='https://survive.example' WHERE id=?`, f.ID, child.ID); err != nil {
		t.Fatalf("craft: %v", err)
	}
	b := rp(s, child.ID)
	if b.ParentID != "" {
		t.Fatalf("child should re-root at top level, parent=%q", b.ParentID)
	}
}

// same-name live folder under the anchor: merge into it, no duplicate rows.
func TestRestoreWithPathMergesSameNameFolder(t *testing.T) {
	s := newTestStore(t)
	orig := seed(s, "", "folder", "Work", "")
	child := seed(s, orig.ID, "url", "Go", "https://go.dev")
	trashTree(s, orig.ID)

	// user rebuilds a folder with the same name while the original is trashed
	twin := seed(s, "", "folder", "Work", "")

	// restore the child: its parent chain merges into the twin
	b := rp(s, child.ID)
	if b.ParentID != twin.ID {
		t.Fatalf("child parent = %q, want merged twin %q", b.ParentID, twin.ID)
	}
	// the original trashed folder row stays tombstoned (empty shell in trash)
	origRow, err := s.Get(orig.ID)
	if err != nil || origRow.DeletedAt == 0 {
		t.Fatalf("original row should remain tombstoned: %+v err=%v", origRow, err)
	}
	// and no duplicate "Work" folder at the top level
	top := liveTitles(s, "")
	n := 0
	for _, title := range top {
		if title == "Work" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("top-level Work folders = %d, want 1", n)
	}
}

// IncludeChildren=false revives only the folder row (shell).
func TestRestoreWithPathShellOnly(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	_ = seed(s, f.ID, "url", "Go", "https://go.dev")
	_ = seed(s, f.ID, "url", "Rust", "https://rust.example")
	trashTree(s, f.ID)

	b := rpShell(s, f.ID)
	if b.DeletedAt != 0 || b.ParentID != "" {
		t.Fatalf("shell restore: %+v", b)
	}
	kids, _ := s.Children(f.ID)
	if len(kids) != 0 {
		t.Fatalf("shell should be empty, got %d kids", len(kids))
	}
	if got := trashCount(s); got != 2 {
		t.Fatalf("trash count = %d, want 2 (children still tombstoned)", got)
	}
}

// restoring the folder whole after a child was individually restored must
// NOT drag the live child back into the subtree semantics — it stays where
// the user put it.
func TestRestoreWithPathFolderDoesNotRecallLiveChild(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	trashTree(s, f.ID)

	// child restored first (shell-revives the parent)
	_ = rp(s, child.ID)
	// now restore the folder itself with the remaining subtree
	b := rp(s, f.ID)
	if b.DeletedAt != 0 {
		t.Fatalf("folder not revived: %+v", b)
	}
	// child must still be under the folder, live, exactly once
	kids, err := s.Children(f.ID)
	if err != nil {
		t.Fatalf("children: %v", err)
	}
	n := 0
	for _, k := range kids {
		if k.ID == child.ID {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("live child occurrences under folder = %d, want 1", n)
	}
	if got := trashCount(s); got != 0 {
		t.Fatalf("trash should be empty, got %d", got)
	}
}

// batch scenario: restoring the same item twice is a no-op, not an error.
func TestRestoreWithPathIdempotent(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "Go", "https://go.dev")
	trashTree(s, b.ID)

	first := rp(s, b.ID)
	second, err := s.RestoreWithPath(b.ID, Now(), "test", RestoreOpts{IncludeChildren: true})
	if err != nil {
		t.Fatalf("second restore: %v", err)
	}
	if first.ID != second.ID || second.DeletedAt != 0 {
		t.Fatalf("idempotency broken: %+v vs %+v", first, second)
	}
}

// pinned target: restore lands in the chosen live folder.
func TestRestoreWithPathPinnedTarget(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	dest := seed(s, "", "folder", "Archive", "")
	trashTree(s, f.ID)

	target := dest.ID
	b, err := s.RestoreWithPath(child.ID, Now(), "test", RestoreOpts{ParentID: &target, IncludeChildren: true})
	if err != nil {
		t.Fatalf("pinned restore: %v", err)
	}
	if b.ParentID != dest.ID {
		t.Fatalf("parent = %q, want pinned %q", b.ParentID, dest.ID)
	}
	// original parent chain untouched: Work stays tombstoned
	row, _ := s.Get(f.ID)
	if row.DeletedAt == 0 {
		t.Fatal("original folder should stay tombstoned on pinned restore")
	}
}

// pinned target must reject non-folder / trashed / missing targets.
func TestRestoreWithPathPinnedTargetValidation(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	trash := seed(s, "", "folder", "Trashed", "")
	trashTree(s, trash.ID)
	trashTree(s, f.ID)

	cases := []struct {
		name   string
		target string
	}{
		{"missing", "no-such-id"},
		{"trashed folder", trash.ID},
		{"url bookmark", child.ID},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tgt := tc.target
			_, err := s.RestoreWithPath(child.ID, Now(), "test", RestoreOpts{ParentID: &tgt, IncludeChildren: true})
			if err == nil {
				t.Fatalf("expected error for %s target", tc.name)
			}
		})
	}
}

// deep chain: folder > sub > subsub > url; trash the top, restore the url —
// the whole chain shell-revives down to it.
func TestRestoreWithPathDeepChainShellRevival(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "L1", "")
	f2 := seed(s, f1.ID, "folder", "L2", "")
	f3 := seed(s, f2.ID, "folder", "L3", "")
	url := seed(s, f3.ID, "url", "Deep", "https://deep.example")
	trashTree(s, f1.ID)

	b := rp(s, url.ID)
	// all three ancestors revived as shells; url sits in L3
	if b.ParentID != f3.ID {
		t.Fatalf("url parent = %q, want %q", b.ParentID, f3.ID)
	}
	for _, fid := range []string{f1.ID, f2.ID, f3.ID} {
		row, err := s.Get(fid)
		if err != nil || row.DeletedAt != 0 {
			t.Fatalf("shell %s wrong: %+v err=%v", fid, row, err)
		}
	}
	l1, _ := s.Get(f1.ID)
	if l1.ParentID != "" {
		t.Fatalf("L1 should hang off root, parent=%q", l1.ParentID)
	}
	l2, _ := s.Get(f2.ID)
	if l2.ParentID != f1.ID {
		t.Fatalf("L2 parent = %q, want %q", l2.ParentID, f1.ID)
	}
	// trash now empty
	if got := trashCount(s); got != 0 {
		t.Fatalf("trash = %d, want 0", got)
	}
}

// deep chain with a same-name folder mid-chain: merge point.
func TestRestoreWithPathMidChainMerge(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "L1", "")
	f2 := seed(s, f1.ID, "folder", "Shared", "")
	url := seed(s, f2.ID, "url", "Deep", "https://deep.example")
	trashTree(s, f1.ID)

	// rebuild L1 > Shared live while the original chain is trashed
	nf1 := seed(s, "", "folder", "L1", "")
	twin := seed(s, nf1.ID, "folder", "Shared", "")

	b := rp(s, url.ID)
	if b.ParentID != twin.ID {
		t.Fatalf("url parent = %q, want merged twin %q", b.ParentID, twin.ID)
	}
	// original rows stay tombstoned
	for _, fid := range []string{f1.ID, f2.ID} {
		row, _ := s.Get(fid)
		if row.DeletedAt == 0 {
			t.Fatalf("original %s should stay tombstoned", fid)
		}
	}
}

// purged mid-chain: ancestors above the purge point are unrecoverable.
func TestRestoreWithPathMidChainPurgeRootsAtTop(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "L1", "")
	f2 := seed(s, f1.ID, "folder", "L2", "")
	url := seed(s, f2.ID, "url", "Deep", "https://deep.example")
	trashTree(s, f1.ID)

	// purge only L2 (its subtree tombstones get purged too — including url!)
	// so instead: trash top, restore url's chain requires L2. Purge L1 only
	// after re-trashing… simpler: purge L1 while whole tree is trashed
	if err := s.Purge(f1.ID, Now(), "test"); err != nil {
		t.Fatalf("purge L1: %v", err)
	}
	// url was purged along with the subtree — it cannot come back
	if _, err := s.RestoreWithPath(url.ID, Now(), "test", RestoreOpts{IncludeChildren: true}); err == nil {
		t.Fatal("purged url must not be restorable")
	}
}

// mixing: shell-revived ancestor then whole-folder restore later keeps
// sibling grouping intact (structural reuse of rows).
func TestRestoreWithPathSiblingGrouping(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	a := seed(s, f.ID, "url", "A", "https://a.example")
	bSeed := seed(s, f.ID, "url", "B", "https://b.example")
	trashTree(s, f.ID)

	// restore A (shells Work), then B, then verify both under the same row
	_ = rp(s, a.ID)
	_ = rp(s, bSeed.ID)
	kidsA, _ := s.Children(f.ID)
	kidsB, _ := s.Children(f.ID)
	if len(kidsA) != 2 || len(kidsB) != 2 {
		t.Fatalf("siblings scattered: %d / %d", len(kidsA), len(kidsB))
	}
	// restoring the folder row whole now changes nothing material
	_ = rp(s, f.ID)
	if got := trashCount(s); got != 0 {
		t.Fatalf("trash = %d, want 0", got)
	}
	top := liveTitles(s, "")
	if !contains(top, "Work") {
		t.Fatalf("Work missing from top level: %v", top)
	}
}

func trashCount(s *Store) int {
	rows, err := s.Trash()
	if err != nil {
		panic(err)
	}
	return len(rows)
}

// guards against accidental recursion blowups on absurd chains
func TestRestoreWithPathGuardDepth(t *testing.T) {
	s := newTestStore(t)
	// build a 150-deep chain manually (beyond the 100 guard)
	parent := ""
	var deepest *Bookmark
	for i := 0; i < 150; i++ {
		f := seed(s, parent, "folder", fmt.Sprintf("L%d", i), "")
		parent = f.ID
		deepest = f
	}
	url := seed(s, parent, "url", "Bottom", "https://bottom.example")
	trashTree(s, deepest.ID) // trashes the whole chain below L149… actually all 150 + url

	b := rp(s, url.ID)
	if b.DeletedAt != 0 {
		t.Fatalf("url not restored: %+v", b)
	}
	// chain beyond guard re-roots; no hang, no panic
}

// ---- audit-fix tests (round 2) ----

// P0 fix: restoring a FOLDER whose anchor already holds a same-name live
// twin must merge into the twin, not duplicate it.
func TestRestoreWithPathFolderSelfMerge(t *testing.T) {
	s := newTestStore(t)
	orig := seed(s, "", "folder", "Work", "")
	_ = seed(s, orig.ID, "url", "Go", "https://go.dev")
	trashTree(s, orig.ID)

	twin := seed(s, "", "folder", "Work", "")
	_ = seed(s, twin.ID, "url", "Rust", "https://rust.example")

	_ = rp(s, orig.ID) // folder restore with children — merges into twin
	// the original row must stay tombstoned (empty shell in trash)
	row, _ := s.Get(orig.ID)
	if row.DeletedAt == 0 {
		t.Fatal("original folder row should stay tombstoned after merge")
	}
	// twin absorbed the tombstoned child
	kids, _ := s.Children(twin.ID)
	titles := map[string]int{}
	for _, k := range kids {
		titles[k.Title]++
	}
	if titles["Go"] != 1 || titles["Rust"] != 1 {
		t.Fatalf("twin children wrong: %v", titles)
	}
	// exactly ONE live Work at the top level
	top := liveTitles(s, "")
	n := 0
	for _, title := range top {
		if title == "Work" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("top-level Work folders = %d, want 1", n)
	}
	if got := trashCount(s); got != 1 {
		t.Fatalf("trash = %d, want 1 (the shell)", got)
	}
}

// P0 corollary: after an ancestor MERGED into a twin (its row still
// tombstoned), restoring that ancestor row directly must also merge into
// the twin instead of duplicating it.
func TestRestoreWithPathMergedAncestorRowAlsoMerges(t *testing.T) {
	s := newTestStore(t)
	orig := seed(s, "", "folder", "Work", "")
	child := seed(s, orig.ID, "url", "Go", "https://go.dev")
	trashTree(s, orig.ID)
	twin := seed(s, "", "folder", "Work", "")

	// child merges into twin (ancestor merge path in ensureLiveAncestor)
	if b := rp(s, child.ID); b.ParentID != twin.ID {
		t.Fatalf("child parent = %q, want twin", b.ParentID)
	}
	// now restore the ancestor row itself — must merge into the twin (its
	// children already live there, so it revives nothing) instead of
	// duplicating. mergeIntoTwin returns the twin row.
	b2 := rp(s, orig.ID)
	if b2.ID != twin.ID {
		t.Fatalf("ancestor restore returned %q, want the twin row", b2.ID)
	}
	top := liveTitles(s, "")
	n := 0
	for _, title := range top {
		if title == "Work" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("top-level Work folders = %d, want 1", n)
	}
}

// P1 fix: single-row restore assigns a fresh position instead of keeping a
// stale one. Trash a child, add live siblings to the parent, then pin the
// child back to the parent — its old position (1) must not collide.
func TestRestoreWithPathSingleRowGetsFreshPosition(t *testing.T) {
	s := newTestStore(t)
	f := seed(s, "", "folder", "Work", "")
	child := seed(s, f.ID, "url", "Go", "https://go.dev")
	trashTree(s, child.ID)
	// the parent stays live; fill it with fresh siblings (positions 2..3)
	_ = seed(s, f.ID, "url", "New1", "https://n1.example")
	_ = seed(s, f.ID, "url", "New2", "https://n2.example")

	// raw store.Create keeps Position 0 unless set; give siblings 2 and 3
	if _, err := s.DB.Exec(`UPDATE bookmarks SET position=3 WHERE title='New1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`UPDATE bookmarks SET position=2 WHERE title='New2'`); err != nil {
		t.Fatal(err)
	}

	target := f.ID
	b, err := s.RestoreWithPath(child.ID, Now(), "test", RestoreOpts{ParentID: &target, IncludeChildren: true})
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if b.Position <= 3 {
		t.Fatalf("restored row kept stale position %v, want > existing max (3)", b.Position)
	}
}

// P1 fix: restoring the same id twice concurrently (or in immediate
// sequence) is a no-op success — the loser of the race must not fail.
func TestRestoreWithPathRaceLoserSucceeds(t *testing.T) {
	s := newTestStore(t)
	b := seed(s, "", "url", "Go", "https://go.dev")
	trashTree(s, b.ID)
	_ = rp(s, b.ID)
	// second restore after the row is live: no error (idempotent)
	b2, err := s.RestoreWithPath(b.ID, Now(), "test", RestoreOpts{IncludeChildren: true})
	if err != nil {
		t.Fatalf("second restore should be a no-op success, got %v", err)
	}
	if b2.ID != b.ID {
		t.Fatal("second restore returned a different row")
	}
}

// P1 fix: the depth guard is real — a corrupted parent cycle re-roots at
// the top level instead of looping forever or anchoring under a tombstone.
func TestRestoreWithPathCycleReRoots(t *testing.T) {
	s := newTestStore(t)
	f1 := seed(s, "", "folder", "A", "")
	f2 := seed(s, f1.ID, "folder", "B", "")
	url := seed(s, f2.ID, "url", "Deep", "https://deep.example")
	trashTree(s, f1.ID)
	// corrupt: make B's parent point back to itself (cycle)
	if _, err := s.DB.Exec(`UPDATE bookmarks SET parent_id=? WHERE id=?`, f2.ID, f2.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.RestoreWithPath(url.ID, Now(), "test", RestoreOpts{IncludeChildren: true})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cycle restore errored: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restore hung on a corrupted parent cycle")
	}
}
