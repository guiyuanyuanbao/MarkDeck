package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/importexport"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
	"github.com/guiyuanyuanbao/MarkDeck/server/internal/tools"
)

// RegisterTools mounts import/export/tools routes (called separately from
// Register so main can pass the tools chain).
func (a *API) RegisterToolsRoutes(mux *http.ServeMux, chain *tools.Chain) {
	mux.HandleFunc("POST /api/import/html", a.requireAny(a.handleImportHTML))
	mux.HandleFunc("GET /api/export/html", a.requireAny(a.handleExportHTML))
	mux.HandleFunc("GET /api/export/json", a.requireAny(a.handleExportJSON))

	mux.HandleFunc("GET /api/tools/deadlinks", a.requireAny(a.handleDeadLinks))
	mux.HandleFunc("GET /api/tools/deadlinks/status", a.requireAny(a.handleDeadScanStatus))
	mux.HandleFunc("POST /api/tools/deadlinks/scan", a.requireAny(a.handleDeadScan))
	mux.HandleFunc("POST /api/tools/deadlinks/clear", a.requireAny(a.handleDeadLinksClear))
	mux.HandleFunc("GET /api/tools/duplicates", a.requireAny(a.handleDuplicates))
	mux.HandleFunc("POST /api/tools/duplicates/merge", a.requireAny(a.handleDupMerge))
	mux.HandleFunc("GET /api/tools/folder-duplicates", a.requireAny(a.handleListFolderDuplicates))
	mux.HandleFunc("POST /api/tools/folder-duplicates/merge", a.requireAny(a.handleFolderDupMerge))

	mux.HandleFunc("GET /api/snapshots", a.requireAny(a.handleListSnapshots))
	mux.HandleFunc("POST /api/snapshots", a.requireAny(a.handleCreateSnapshot))
	mux.HandleFunc("POST /api/snapshots/upload", a.requireAny(a.handleUploadSnapshot))
	mux.HandleFunc("POST /api/snapshots/{id}/restore", a.requireAny(a.handleRestoreSnapshot))
	mux.HandleFunc("GET /api/snapshots/{id}/download", a.requireAny(a.handleDownloadSnapshot))

	// trash auto-purge retention (registered here — it belongs to the tools
	// chain, not the auth handlers file where it used to sit)
	mux.HandleFunc("GET /api/trash/retention", a.requireSession(a.handleGetTrashRetention))
	mux.HandleFunc("POST /api/trash/retention", a.requireSession(a.handleSetTrashRetention))
}

// handleGetTrashRetention returns the auto-purge window in days (0 = never).
func (a *API) handleGetTrashRetention(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]int{"days": a.chain.TrashRetentionDays()})
}

// handleSetTrashRetention stores the auto-purge window. 0 = never; presets
// 1/7/30/90 or any custom 0..3650 value.
func (a *API) handleSetTrashRetention(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Days int `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if err := a.chain.SetTrashRetention(body.Days); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// apply immediately so the admin sees the sweep without waiting an hour
	purged := a.chain.EnforceTrashRetention(store.Now())
	writeJSON(w, http.StatusOK, map[string]int{"days": body.Days, "purged": purged})
}

// handleUploadSnapshot accepts a previously downloaded snapshot file
// (.json.gz) and restores it. Completes the download half of the backup
// story: cold copies / cross-instance moves can come back without shell
// access. A protective snapshot of the current state is taken first.
// readMultipartFile reads the "file" field of an already-parsed multipart
// form, capping at maxBytes (a shared shape: import and snapshot upload used
// to carry two different hand-rolled readers).
func readMultipartFile(r *http.Request, maxBytes int64) ([]byte, error) {
	file, _, err := r.FormFile("file")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buf, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > maxBytes {
		return nil, errFileTooLarge
	}
	return buf, nil
}

var errFileTooLarge = errors.New("file too large")

// decodeMergeRequest parses + validates the shared keepId/removeIds body of
// the duplicate-merge endpoints (validation used to be copy-pasted ×2).
type mergeRequest struct {
	KeepID    string   `json:"keepId"`
	RemoveIDs []string `json:"removeIds"`
}

func decodeMergeRequest(w http.ResponseWriter, r *http.Request) (mergeRequest, bool) {
	var body mergeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.KeepID == "" || len(body.RemoveIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keepId and removeIds required"})
		return body, false
	}
	for _, id := range body.RemoveIDs {
		if id == body.KeepID {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keepId in removeIds"})
			return body, false
		}
	}
	return body, true
}

func (a *API) handleUploadSnapshot(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil { // 64 MiB upload cap
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "multipart required"})
		return
	}
	data, err := readMultipartFile(r, 64<<20)
	if err != nil {
		if errors.Is(err, errFileTooLarge) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file field required"})
		return
	}
	row, err := a.chain.RestoreSnapshotFile(data, "import")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, row)
}

func (a *API) handleImportHTML(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32 MiB upload cap
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "multipart required"})
		return
	}
	buf, err := readMultipartFile(r, 64<<20)
	if err != nil {
		if errors.Is(err, errFileTooLarge) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file field required"})
		return
	}
	root, err := importexport.ParseNetscapeHTML(buf)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "parse failed: " + err.Error()})
		return
	}
	mode := r.FormValue("mode")
	if mode != "newfolder" && mode != "merge" {
		mode = "newfolder"
	}
	res, err := importexport.Import(a.Store, root, importexport.ImportOptions{
		Mode: mode, RootName: r.FormValue("rootName"), DeviceID: "import",
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, res)
}

func (a *API) handleExportHTML(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.Store.Tree()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	out, err := importexport.ExportNetscapeHTML(nodes)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="markdeck-bookmarks.html"`)
	_, _ = w.Write(out)
}

func (a *API) handleExportJSON(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.Store.Tree()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	trash, _ := a.Store.Trash()
	all := append(nodes, trash...)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="markdeck-export.json"`)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"exportedAt": time.Now().Unix(),
		"bookmarks":  all,
	})
}

func (a *API) handleDeadLinks(w http.ResponseWriter, r *http.Request) {
	links, err := a.chain.DeadLinks()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if links == nil {
		links = []tools.DeadLink{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"links": links})
}

func (a *API) handleDeadScanStatus(w http.ResponseWriter, r *http.Request) {
	running, lastAt := a.chain.ScanStatus()
	writeJSON(w, http.StatusOK, map[string]any{"running": running, "lastScanAt": lastAt})
}

func (a *API) handleDeadScan(w http.ResponseWriter, r *http.Request) {
	// async: return immediately, UI polls /api/tools/deadlinks
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	go func() {
		defer cancel()
		// ScanDeadLinks does not log failures itself; surface them here so an
		// aborted scan is diagnosable instead of silently disappearing
		if _, err := a.chain.ScanDeadLinks(ctx); err != nil {
			log.Printf("dead-link scan: %v", err)
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "started"})
}

func (a *API) handleDeadLinksClear(w http.ResponseWriter, r *http.Request) {
	if err := a.chain.ClearDeadLinks(); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleDuplicates(w http.ResponseWriter, r *http.Request) {
	groups, err := a.chain.FindDuplicates()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	if groups == nil {
		groups = []tools.DupGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (a *API) handleDupMerge(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeMergeRequest(w, r)
	if !ok {
		return
	}
	// same-group validation: merge deletes nodes, so it must refuse ids that
	// are NOT actual duplicate-URL group members — otherwise this endpoint
	// is an arbitrary-delete primitive for any bearer/holder
	if err := a.chain.ValidateDuplicateGroup(body.KeepID, body.RemoveIDs); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := a.chain.MergeDuplicate(body.KeepID, body.RemoveIDs); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleListFolderDuplicates(w http.ResponseWriter, r *http.Request) {
	groups, err := a.chain.FindFolderDuplicates()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (a *API) handleFolderDupMerge(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeMergeRequest(w, r)
	if !ok {
		return
	}
	if err := a.chain.ValidateFolderDuplicateGroup(body.KeepID, body.RemoveIDs); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	moved, err := a.chain.MergeFolderDuplicates(body.KeepID, body.RemoveIDs)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]any{"ok": "1", "moved": moved})
}

func (a *API) handleListSnapshots(w http.ResponseWriter, r *http.Request) {
	rows, err := a.chain.ListSnapshots()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": rows})
}

func (a *API) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	row, err := a.chain.TakeSnapshot("manual")
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (a *API) handleRestoreSnapshot(w http.ResponseWriter, r *http.Request) {
	if err := a.chain.RestoreSnapshot(r.PathValue("id"), "restore"); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleDownloadSnapshot(w http.ResponseWriter, r *http.Request) {
	path, row, err := a.chain.SnapshotPath(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "snapshot not found"})
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+row.File+`"`)
	http.ServeFile(w, r, path)
}
