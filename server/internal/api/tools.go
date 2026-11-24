package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/importexport"
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
	mux.HandleFunc("GET /api/tools/duplicates", a.requireAny(a.handleDuplicates))
	mux.HandleFunc("POST /api/tools/duplicates/merge", a.requireAny(a.handleDupMerge))
	mux.HandleFunc("GET /api/tools/folder-duplicates", a.requireAny(a.handleListFolderDuplicates))
	mux.HandleFunc("POST /api/tools/folder-duplicates/merge", a.requireAny(a.handleFolderDupMerge))

	mux.HandleFunc("GET /api/snapshots", a.requireAny(a.handleListSnapshots))
	mux.HandleFunc("POST /api/snapshots", a.requireAny(a.handleCreateSnapshot))
	mux.HandleFunc("POST /api/snapshots/{id}/restore", a.requireAny(a.handleRestoreSnapshot))
	mux.HandleFunc("GET /api/snapshots/{id}/download", a.requireAny(a.handleDownloadSnapshot))
}

func (a *API) handleImportHTML(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32 MiB upload cap
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "multipart required"})
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file field required"})
		return
	}
	defer file.Close()
	var buf = make([]byte, 0, 1<<20)
	tmp := make([]byte, 64<<10)
	for {
		n, e := file.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if e != nil {
			break
		}
		if len(buf) > 64<<20 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file too large"})
			return
		}
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
		if _, err := a.chain.ScanDeadLinks(ctx); err != nil {
			// logged inside chain; nothing else to do
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "started"})
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
	var body struct {
		KeepID    string   `json:"keepId"`
		RemoveIDs []string `json:"removeIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.KeepID == "" || len(body.RemoveIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keepId and removeIds required"})
		return
	}
	for _, id := range body.RemoveIDs {
		if id == body.KeepID {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keepId in removeIds"})
			return
		}
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
	var body struct {
		KeepID    string   `json:"keepId"`
		RemoveIDs []string `json:"removeIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.KeepID == "" || len(body.RemoveIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keepId and removeIds required"})
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
