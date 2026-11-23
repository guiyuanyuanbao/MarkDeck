package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// SyncPull returns all rows with revision > since, plus the current max
// revision so clients know when they've caught up.
func (a *API) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil || since < 0 {
		since = 0
	}
	rows, maxRev, err := a.Store.ChangesSince(since, 2000)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if rows == nil {
		rows = []*store.Bookmark{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"changes": rows,
		"head":    maxRev,
	})
}

type pushOp struct {
	ID        string    `json:"id"`
	ParentID  *string   `json:"parentId,omitempty"`
	Type      *string   `json:"type,omitempty"`
	Title     *string   `json:"title,omitempty"`
	URL       *string   `json:"url,omitempty"`
	Note      *string   `json:"note,omitempty"`
	Favorite  *bool     `json:"favorite,omitempty"`
	Archived  *bool     `json:"archived,omitempty"`
	Position  *float64  `json:"position,omitempty"`
	DeletedAt *int64    `json:"deletedAt,omitempty"` // client may set >0 to trash
	Purged    *bool     `json:"purged,omitempty"`
	UpdatedAt int64     `json:"updatedAt"`
	DeviceID  string    `json:"deviceId"`
	Tags      *[]string `json:"tags,omitempty"`
	// BaseRevision is the change-log revision the op was authored against
	// (from the client's pulled copy). On same-second UpdatedAt ties it
	// distinguishes a legitimate follow-up edit (base >= current row's
	// revision) from a stale op racing a snapshot restore (base below).
	BaseRevision int64 `json:"baseRevision,omitempty"`
}

type pushResult struct {
	ID    string          `json:"id"`
	Win   bool            `json:"win"`   // true if client op was applied
	State *store.Bookmark `json:"state"` // authoritative post-merge row
	Error string          `json:"error,omitempty"`
}

// SyncPush applies a batch of client ops under LWW rules. Each op is
// independent; failures don't abort the batch.
func (a *API) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	var ops []pushOp
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&ops); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	out := make([]pushResult, 0, len(ops))
	anyWin := false
	for _, op := range ops {
		res := a.applyOp(&op)
		out = append(out, res)
		if res.Win {
			anyWin = true
		}
	}
	if anyWin {
		a.broadcastRevision()
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out})
}

// validParent reports whether parentId refers to an existing row (or none).
// A missing parent means the client pushed a local root id we don't model.
func (a *API) validParent(parent string) bool {
	if parent == "" {
		return true
	}
	_, err := a.Store.Get(parent)
	return err == nil
}

func (a *API) applyOp(op *pushOp) pushResult {
	at := store.Now()
	if op.UpdatedAt > at+300 { // future clock beyond 5 min: clamp
		op.UpdatedAt = at + 300
	}
	if op.UpdatedAt <= 0 {
		op.UpdatedAt = at
	}
	if op.DeviceID == "" {
		op.DeviceID = "unknown"
	}

	cur, err := a.Store.Get(op.ID)
	if err != nil {
		if err != store.ErrNotFound {
			return pushResult{ID: op.ID, Error: err.Error()}
		}
		// create path
		if op.Type == nil || (op.Type != nil && *op.Type != "folder" && *op.Type != "url") {
			return pushResult{ID: op.ID, Error: "new row requires type folder|url"}
		}
		parent := deref(op.ParentID)
		if !a.validParent(parent) {
			// browsers push their fixed root ids ('1'/'2') as parentId; the
			// server has no such rows, so an unnormalized parent would orphan
			// the node in the web UI tree (fall back to top level)
			parent = ""
		}
		b := &store.Bookmark{
			ID: op.ID, ParentID: parent, Type: *op.Type,
			Title: deref(op.Title), URL: deref(op.URL), Note: deref(op.Note),
			Favorite: derefB(op.Favorite), Archived: derefB(op.Archived),
			Position: derefF(op.Position), DeletedAt: derefI(op.DeletedAt),
			UpdatedAt: op.UpdatedAt, DeviceID: op.DeviceID, CreatedAt: at,
		}
		var tags []string
		if op.Tags != nil {
			tags = *op.Tags
		}
		created, err := a.Store.Create(b, tags)
		if err != nil {
			return pushResult{ID: op.ID, Error: err.Error()}
		}
		return pushResult{ID: op.ID, Win: true, State: created}
	}

	// Existing row: build merged candidate, LWW decides.
	cand := *cur
	if op.ParentID != nil {
		cand.ParentID = *op.ParentID
		if !a.validParent(cand.ParentID) {
			cand.ParentID = ""
		}
	}
	if op.Type != nil {
		cand.Type = *op.Type
	}
	if op.Title != nil {
		cand.Title = *op.Title
	}
	if op.URL != nil {
		cand.URL = *op.URL
	}
	if op.Note != nil {
		cand.Note = *op.Note
	}
	if op.Favorite != nil {
		cand.Favorite = *op.Favorite
	}
	if op.Archived != nil {
		cand.Archived = *op.Archived
	}
	if op.Position != nil {
		cand.Position = *op.Position
	}
	if op.DeletedAt != nil {
		cand.DeletedAt = *op.DeletedAt
		if *op.DeletedAt == 0 {
			cand.Purged = false // un-delete also revives
		}
	}
	if op.Purged != nil && *op.Purged {
		cand.Purged = true
		cand.DeletedAt = at
	}
	cand.UpdatedAt = op.UpdatedAt
	cand.DeviceID = op.DeviceID

	// Purged tombstones are terminal: nothing un-deletes them.
	if cur.Purged && cand.DeletedAt == 0 {
		return pushResult{ID: op.ID, Win: false, State: cur}
	}

	merged, win, err := a.Store.UpdateLWWBase(&cand, derefTags(op.Tags), op.BaseRevision)
	if err != nil {
		return pushResult{ID: op.ID, Error: err.Error()}
	}
	return pushResult{ID: op.ID, Win: win, State: merged}
}

// SyncStatus reports the server head revision and node counts — used by
// clients to decide between incremental pull and full re-sync.
func (a *API) handleSyncStatus(w http.ResponseWriter, r *http.Request) {
	maxRev, err := a.Store.MaxRevision()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	ids, _ := a.Store.SubtreeIDs("")
	writeJSON(w, http.StatusOK, map[string]any{"head": maxRev, "nodes": len(ids)})
}

func derefTags(p *[]string) []string {
	if p == nil {
		return nil
	}
	return *p
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func derefB(p *bool) bool {
	if p == nil {
		return false
	}
	return *p
}
func derefF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
func derefI(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
