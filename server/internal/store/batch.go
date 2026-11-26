package store

import (
	"database/sql"
	"fmt"
)

// ---- snapshot-reconciliation batch protocol ----
//
// The extension no longer streams per-event ops; it computes a three-way
// diff (base / server / local) and sends the resulting mutations here in one
// transaction. Identity is the server UUID everywhere — there are no
// client-side id-mapping tables to drift, and a failed op simply leaves the
// client's base untouched, so the next reconcile re-plans identical ops.

// BatchOp is one mutation inside an ApplyBatch. Op is "create" | "update" |
// "delete". ObservedRevision is the row revision the client last saw (from
// its base snapshot): on same-second LWW ties it distinguishes a legitimate
// follow-up edit from a stale op racing a concurrent write the client never
// saw — same rule the old per-op push protocol used with BaseRevision.
type BatchOp struct {
	ID       string   `json:"id"`
	Op       string   `json:"op"`
	Type     string   `json:"type,omitempty"`
	ParentID *string  `json:"parentId,omitempty"`
	Title    *string  `json:"title,omitempty"`
	URL      *string  `json:"url,omitempty"`
	Note     *string  `json:"note,omitempty"`
	Favorite *bool    `json:"favorite,omitempty"`
	Archived *bool    `json:"archived,omitempty"`
	Position *float64 `json:"position,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	// Undelete revives a tombstoned row (the reconciler's "local edit wins
	// against a server delete" path — the edit is newer, the row must come
	// back). Without it a batch update keeps cur's tombstone and the row
	// stays invisible in every tree.
	Undelete         bool   `json:"undelete,omitempty"`
	UpdatedAt        int64  `json:"updatedAt"`
	DeviceID         string `json:"deviceId"`
	ObservedRevision int64  `json:"observedRevision,omitempty"`
}

// BatchResult reports the post-merge authoritative row per op.
type BatchResult struct {
	ID    string    `json:"id"`
	Win   bool      `json:"win"`
	Error string    `json:"error,omitempty"`
	State *Bookmark `json:"state,omitempty"`
}

// ApplyBatch applies client mutations in one transaction. Per-op failures
// are reported but never abort the batch (partial wins are fine: the client
// re-plans from its unchanged base next reconcile). The caller must order
// parent rows before children (the reconciler topologically sorts); parent
// validation runs inside the tx, so earlier same-batch parents pass.
func (s *Store) ApplyBatch(ops []BatchOp, at int64) []BatchResult {
	tx, err := s.DB.Begin()
	if err != nil {
		return allFailed(ops, err)
	}
	defer tx.Rollback()

	results := make([]BatchResult, 0, len(ops))
	for i := range ops {
		results = append(results, s.applyBatchOp(tx, &ops[i], at))
	}
	if err := tx.Commit(); err != nil {
		return allFailed(ops, err)
	}
	return results
}

func (s *Store) applyBatchOp(tx *sql.Tx, op *BatchOp, at int64) BatchResult {
	device := op.DeviceID
	if device == "" {
		device = "unknown"
	}
	updated := op.UpdatedAt
	if updated <= 0 {
		updated = at
	}
	if updated > at+300 { // future clock beyond 5 min: clamp
		updated = at + 300
	}

	cur, err := getBookmarkTx(tx, op.ID)
	if err != nil && err != ErrNotFound {
		return BatchResult{ID: op.ID, Error: err.Error()}
	}

	switch op.Op {
	case "create":
		if cur != nil {
			// row already exists: treat as an idempotent re-apply (half-
			// applied batch replay); LWW decides whether anything changes
			return s.batchUpdate(tx, cur, op, device, updated)
		}
		if op.Type != "folder" && op.Type != "url" {
			return BatchResult{ID: op.ID, Error: "create requires type folder|url"}
		}
		if op.Type == "url" && derefStr(op.URL) == "" {
			return BatchResult{ID: op.ID, Error: "url bookmarks require a URL"}
		}
		parent := derefStr(op.ParentID)
		if parent != "" {
			p, perr := getBookmarkTx(tx, parent)
			if perr != nil {
				return BatchResult{ID: op.ID, Error: fmt.Sprintf("parent %q does not exist", parent)}
			}
			if p.DeletedAt > 0 {
				return BatchResult{ID: op.ID, Error: fmt.Sprintf("parent %q is in the trash", parent)}
			}
		}
		b := &Bookmark{
			ID: op.ID, ParentID: parent, Type: op.Type,
			Title:    derefStr(op.Title),
			URL:      derefStr(op.URL),
			Note:     derefStr(op.Note),
			Favorite: derefBool(op.Favorite), Archived: derefBool(op.Archived),
			Position:  derefFloat(op.Position),
			UpdatedAt: updated, DeviceID: device, CreatedAt: at,
		}
		if err := insertBookmark(tx, b); err != nil {
			return BatchResult{ID: op.ID, Error: err.Error()}
		}
		if op.Tags != nil {
			if err := setTags(tx, b.ID, op.Tags); err != nil {
				return BatchResult{ID: op.ID, Error: err.Error()}
			}
		}
		rev, err := bumpChange(tx, b.ID)
		if err != nil {
			return BatchResult{ID: op.ID, Error: err.Error()}
		}
		b.Revision = rev
		return BatchResult{ID: op.ID, Win: true, State: b}

	case "update":
		if cur == nil {
			// the client's base contained this row, so it existed — a
			// missing row here means a hard delete raced the plan; the
			// create fallback repairs toward the client's view
			op2 := *op
			op2.Op = "create"
			if op2.Type != "folder" && op2.Type != "url" {
				if derefStr(op2.URL) != "" {
					op2.Type = "url"
				} else {
					op2.Type = "folder"
				}
			}
			return s.applyBatchOp(tx, &op2, at)
		}
		return s.batchUpdate(tx, cur, op, device, updated)

	case "delete":
		if cur == nil || cur.DeletedAt > 0 {
			return BatchResult{ID: op.ID, Win: true} // already absent/trashed
		}
		ids, err := subtreeIDs(tx, op.ID)
		if err != nil {
			return BatchResult{ID: op.ID, Error: err.Error()}
		}
		for _, bid := range ids {
			if _, err := tx.Exec(`UPDATE bookmarks SET deleted_at=?, purged=0, updated_at=?, device_id=? WHERE id=?`,
				at, updated, device, bid); err != nil {
				return BatchResult{ID: op.ID, Error: err.Error()}
			}
			if _, err := bumpChange(tx, bid); err != nil {
				return BatchResult{ID: op.ID, Error: err.Error()}
			}
		}
		return BatchResult{ID: op.ID, Win: true}

	default:
		return BatchResult{ID: op.ID, Error: fmt.Sprintf("unknown op %q", op.Op)}
	}
}

// batchUpdate merges op fields into cur and decides LWW. Same-second ties
// resolve exactly like the old push protocol: an op authored against the
// revision the server already holds (observed >= current) is a legitimate
// follow-up edit and wins; an op authored against older history (the row
// moved on unseen) loses.
func (s *Store) batchUpdate(tx *sql.Tx, cur *Bookmark, op *BatchOp, device string, updated int64) BatchResult {
	if cur.UpdatedAt > updated {
		return BatchResult{ID: op.ID, Win: false, State: cur}
	}
	if cur.UpdatedAt == updated && cur.DeviceID != device && cur.Revision > op.ObservedRevision {
		return BatchResult{ID: op.ID, Win: false, State: cur}
	}

	merged := *cur
	if op.ParentID != nil {
		merged.ParentID = *op.ParentID
	}
	if op.Type == "folder" || op.Type == "url" {
		merged.Type = op.Type
	}
	if op.Title != nil {
		merged.Title = *op.Title
	}
	if op.URL != nil {
		merged.URL = *op.URL
	}
	if op.Note != nil {
		merged.Note = *op.Note
	}
	if op.Favorite != nil {
		merged.Favorite = *op.Favorite
	}
	if op.Archived != nil {
		merged.Archived = *op.Archived
	}
	if op.Position != nil {
		merged.Position = *op.Position
	}
	merged.UpdatedAt = updated
	merged.DeviceID = device
	if op.Undelete && merged.DeletedAt > 0 {
		// explicit revive: clear the tombstone (purged rows stay terminal —
		// content is gone and nothing can bring it back)
		if !merged.Purged {
			merged.DeletedAt = 0
			merged.Purged = false
		}
	}
	// otherwise deletion state stays as-is: deletes go through the "delete"
	// branch (which tombstones the whole subtree), updates never flip it

	if err := updateBookmark(tx, &merged); err != nil {
		return BatchResult{ID: op.ID, Error: err.Error()}
	}
	if op.Tags != nil {
		if err := setTags(tx, op.ID, op.Tags); err != nil {
			return BatchResult{ID: op.ID, Error: err.Error()}
		}
	}
	rev, err := bumpChange(tx, op.ID)
	if err != nil {
		return BatchResult{ID: op.ID, Error: err.Error()}
	}
	merged.Revision = rev
	return BatchResult{ID: op.ID, Win: true, State: &merged}
}

// ---- tx helpers ----

func getBookmarkTx(tx *sql.Tx, id string) (*Bookmark, error) {
	row := tx.QueryRow(`SELECT `+scanCols+` FROM bookmarks WHERE id = ?`, id)
	return scanBookmark(row.Scan)
}

func allFailed(ops []BatchOp, err error) []BatchResult {
	out := make([]BatchResult, 0, len(ops))
	for _, op := range ops {
		out = append(out, BatchResult{ID: op.ID, Error: err.Error()})
	}
	return out
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefBool(p *bool) bool {
	if p == nil {
		return false
	}
	return *p
}

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
