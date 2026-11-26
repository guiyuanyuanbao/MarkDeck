package api

import (
	"encoding/json"
	"net/http"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// ---- snapshot-reconciliation protocol (0.1.0+) ----
//
// The extension computes a three-way diff against its last synced base
// snapshot and applies the result in one round-trip each way:
//
//   GET  /api/sync/tree   → full live tree + head revision + canonical
//                           other-bookmarks holder id (structural binding,
//                           no client-side id maps exist anymore)
//   POST /api/sync/apply  ← batched create/update/delete ops (single tx)

// SyncTree is the full server state the reconciler diffs against its base.
func (a *API) handleSyncTree(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.Store.Tree()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if nodes == nil {
		nodes = []*store.Bookmark{}
	}
	head, err := a.Store.MaxRevision()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"head":     head,
		"othersId": store.CanonicalOthersID(),
		"nodes":    nodes,
	})
}

// SyncApply runs the batch and broadcasts once when anything won.
func (a *API) handleSyncApply(w http.ResponseWriter, r *http.Request) {
	var ops []store.BatchOp
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&ops); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if len(ops) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []store.BatchResult{}, "head": mustHead(a)})
		return
	}
	results := a.Store.ApplyBatch(ops, store.Now())
	head, err := a.Store.MaxRevision()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	anyWin := false
	for _, res := range results {
		if res.Win {
			anyWin = true
			break
		}
	}
	if anyWin {
		a.broadcastRevision()
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results, "head": head})
}

// SyncStatus reports the server head revision — diagnostics only now (the
// reconciler uses /api/sync/tree's head, not this).
func (a *API) handleSyncStatus(w http.ResponseWriter, r *http.Request) {
	head, err := a.Store.MaxRevision()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	ids, _ := a.Store.SubtreeIDs("")
	writeJSON(w, http.StatusOK, map[string]any{"head": head, "nodes": len(ids)})
}

func mustHead(a *API) int64 {
	h, err := a.Store.MaxRevision()
	if err != nil {
		return 0
	}
	return h
}
