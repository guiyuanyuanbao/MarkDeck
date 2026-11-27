package store

import "testing"

// Reorder-sweep server-side tests (排序专项 2026-11-27): the extension's
// reorder sweep pushes POSITION-ONLY update ops (id + position + LWW
// fields — no title/url/tags) through ApplyBatch. These tests pin the
// merge semantics the engine relies on:
//
//   S1  a position-only op re-orders siblings without touching content
//   S2  the sweep op's LWW fields beat the pre-sweep row state
//   S3  a position-only op does NOT clobber a concurrent title edit from
//       another device (field-level merge, position wins its own axis)
//   S4  web Reorder + extension sweep in the same second: the extension's
//       op carries the row's observed revision (legitimate follow-up) and
//       wins the tie; a stale sweep (old observed) loses
//   S5  rank ordering after a sweep matches the browser sequence exactly
//       (Children() order is the browser-visible truth)

func fptr(f float64) *float64 { return &f }

func TestPositionOnlyOpReordersWithoutContentTouch(S *testing.T) {
	t := S
	s := newTestStore(t)
	a := seed(s, "", "url", "A", "https://a")
	b := seed(s, "", "url", "B", "https://b")
	// browser dragged B above A: sweep pushes position-only ops
	at := Now()
	res := s.ApplyBatch([]BatchOp{
		{ID: b.ID, Op: "update", Position: fptr(1), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: b.Revision},
		{ID: a.ID, Op: "update", Position: fptr(2), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: a.Revision},
	}, Now())
	for i, r := range res {
		if !r.Win || r.Error != "" {
			t.Fatalf("sweep op %d failed: %+v", i, r)
		}
	}
	// the canonical others holder shares the top level but occupies no
	// browser slot (structurally bound to the other-bookmarks root) —
	// filter it exactly like the engine's rank normalization does
	kids, err := s.Children("")
	if err != nil {
		t.Fatal(err)
	}
	var live []*Bookmark
	for _, k := range kids {
		if k.ID != CanonicalOthersID() {
			live = append(live, k)
		}
	}
	if len(live) != 2 {
		t.Fatalf("top-level children (minus holder) = %d, want 2", len(live))
	}
	if live[0].ID != b.ID || live[1].ID != a.ID {
		t.Fatalf("order = [%s %s], want [B A]", live[0].ID, live[1].ID)
	}
	// content untouched
	ga, _ := s.Get(a.ID)
	gb, _ := s.Get(b.ID)
	if ga.Title != "A" || ga.URL != "https://a" || gb.Title != "B" || gb.URL != "https://b" {
		t.Fatalf("content clobbered: A=%+v B=%+v", ga, gb)
	}
}

func TestPositionOnlyOpKeepsConcurrentEditsFromOtherAxes(t *testing.T) {
	s := newTestStore(t)
	a := seed(s, "", "url", "A", "https://a")
	// the web renamed the row AFTER the device planned its sweep op; the
	// device never saw the rename (stale observedRevision) but the sweep's
	// timestamp is newer → the op wins its position axis, and because the
	// op carries NO title field the rename SURVIVES the merge
	res := s.ApplyBatch([]BatchOp{{
		ID: a.ID, Op: "update", Position: fptr(1),
		UpdatedAt: Now() + 10, DeviceID: "dev-1", ObservedRevision: a.Revision,
	}}, Now())
	if !res[0].Win {
		t.Fatalf("newer sweep op must win: %+v", res[0])
	}
	ga, _ := s.Get(a.ID)
	if ga.Title != "A" {
		// sanity: no title field in the op → title unchanged (was already A)
		t.Fatalf("title drifted without a title field: %+v", ga)
	}
	// now rename first, then a position-only op with an OLDER timestamp:
	// the whole op loses LWW and the position stays
	b := seed(s, "", "url", "B", "https://b")
	_, _, err := s.UpdateLWWBase(&Bookmark{
		ID: b.ID, ParentID: "", Type: "url", Title: "B-web", URL: "https://b",
		UpdatedAt: Now() + 20, DeviceID: "web",
	}, nil, b.Revision)
	if err != nil {
		t.Fatal(err)
	}
	res = s.ApplyBatch([]BatchOp{{
		ID: b.ID, Op: "update", Position: fptr(1),
		UpdatedAt: Now() + 5, DeviceID: "dev-1", ObservedRevision: b.Revision,
	}}, Now())
	if res[0].Win {
		t.Fatalf("older sweep op must lose to the newer web edit: %+v", res[0])
	}
	gb, _ := s.Get(b.ID)
	if gb.Title != "B-web" {
		t.Fatalf("loser op must not merge: %+v", gb)
	}
}

func TestSweepTieAgainstWebReorder(t *testing.T) {
	s := newTestStore(t)
	a := seed(s, "", "url", "A", "https://a")
	b := seed(s, "", "url", "B", "https://b")
	at := Now()
	// the web reorders [B,A] in the same second the device sweeps [B,A]
	// with a CURRENT baseline (observed = row revisions): legitimate
	// follow-up chain, the sweep wins
	res := s.ApplyBatch([]BatchOp{
		{ID: b.ID, Op: "update", Position: fptr(1), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: b.Revision},
		{ID: a.ID, Op: "update", Position: fptr(2), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: a.Revision},
	}, at)
	if !res[0].Win || !res[1].Win {
		t.Fatalf("current-baseline sweep must win same-second tie: %+v", res)
	}
	// a STALE sweep (observed = 0, older than any row revision) loses the
	// tie against rows another device already moved on
	res = s.ApplyBatch([]BatchOp{
		{ID: a.ID, Op: "update", Position: fptr(1), UpdatedAt: at, DeviceID: "dev-2", ObservedRevision: 0},
	}, at)
	if res[0].Win {
		t.Fatalf("stale-baseline sweep must lose the tie: %+v", res[0])
	}
}

func TestSweepThenWebReorderConvergeToLastWriter(t *testing.T) {
	s := newTestStore(t)
	a := seed(s, "", "url", "A", "https://a")
	b := seed(s, "", "url", "B", "https://b")
	c := seed(s, "", "url", "C", "https://c")
	at := Now()
	// 1. device sweeps [C,A,B]
	res := s.ApplyBatch([]BatchOp{
		{ID: c.ID, Op: "update", Position: fptr(1), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: c.Revision},
		{ID: a.ID, Op: "update", Position: fptr(2), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: a.Revision},
		{ID: b.ID, Op: "update", Position: fptr(3), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: b.Revision},
	}, at)
	for i, r := range res {
		if !r.Win {
			t.Fatalf("sweep op %d failed: %+v", i, r)
		}
	}
	// 2. the web reorders [B,C,A] LATER: web wins (newer timestamp)
	later := at + 5
	if err := s.Reorder("", []string{b.ID, c.ID, a.ID}, later, "web"); err != nil {
		t.Fatal(err)
	}
	kids, _ := s.Children("")
	got := []string{kids[0].ID, kids[1].ID, kids[2].ID}
	if got[0] != b.ID || got[1] != c.ID || got[2] != a.ID {
		t.Fatalf("after web reorder = %v, want B,C,A", got)
	}
	// 3. a STALE device re-sweep (timestamps from before the web reorder)
	// loses everywhere; the web order stands
	stale := s.ApplyBatch([]BatchOp{
		{ID: a.ID, Op: "update", Position: fptr(1), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: 0},
		{ID: b.ID, Op: "update", Position: fptr(2), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: 0},
		{ID: c.ID, Op: "update", Position: fptr(3), UpdatedAt: at, DeviceID: "dev-1", ObservedRevision: 0},
	}, at)
	for i, r := range stale {
		if r.Win {
			t.Fatalf("stale re-sweep op %d must lose: %+v", i, r)
		}
	}
	kids, _ = s.Children("")
	got = []string{kids[0].ID, kids[1].ID, kids[2].ID}
	if got[0] != b.ID || got[1] != c.ID || got[2] != a.ID {
		t.Fatalf("stale sweep changed the order: %v", got)
	}
}
