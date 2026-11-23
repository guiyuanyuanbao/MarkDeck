package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

func (a *API) handleTree(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.Store.Tree()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

func (a *API) handleTrash(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.Store.Trash()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes})
}

type createReq struct {
	ParentID string   `json:"parentId"`
	Type     string   `json:"type"`
	Title    string   `json:"title"`
	URL      string   `json:"url"`
	Note     string   `json:"note"`
	Tags     []string `json:"tags"`
	Favorite *bool    `json:"favorite"`
}

func (a *API) handleCreate(w http.ResponseWriter, r *http.Request) {
	var body createReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if body.Type != "folder" && body.Type != "url" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type must be folder|url"})
		return
	}
	if body.Type == "url" && body.URL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url required"})
		return
	}
	max, err := a.Store.MaxPosition(body.ParentID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	b := &store.Bookmark{
		ParentID: body.ParentID, Type: body.Type, Title: body.Title,
		URL: body.URL, Note: body.Note, Position: max + 1,
		Favorite:  body.Favorite != nil && *body.Favorite,
		UpdatedAt: store.Now(), DeviceID: "web",
	}
	created, err := a.Store.Create(b, body.Tags)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusCreated, created)
}

type updateReq struct {
	Title    *string   `json:"title"`
	URL      *string   `json:"url"`
	Note     *string   `json:"note"`
	Favorite *bool     `json:"favorite"`
	Archived *bool     `json:"archived"`
	Tags     *[]string `json:"tags"`
}

func (a *API) handleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body updateReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	cur, err := a.Store.Get(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if body.Title != nil {
		cur.Title = *body.Title
	}
	if body.URL != nil && cur.Type == "url" {
		cur.URL = *body.URL
	}
	if body.Note != nil {
		cur.Note = *body.Note
	}
	if body.Favorite != nil {
		cur.Favorite = *body.Favorite
	}
	if body.Archived != nil {
		cur.Archived = *body.Archived
	}
	cur.UpdatedAt = store.Now()
	cur.DeviceID = "web"
	var tags []string
	if body.Tags != nil {
		tags = *body.Tags
	}
	// web edits are authored against the row just read: quoting its revision
	// makes same-second consecutive web edits win their LWW tie
	updated, _, err := a.Store.UpdateLWWBase(cur, tags, cur.Revision)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, updated)
}

func (a *API) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ids, err := a.Store.DeleteSoft(id, store.Now(), "web")
	if err == store.ErrNotFound {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": ids})
}

func (a *API) handleRestore(w http.ResponseWriter, r *http.Request) {
	b, err := a.Store.Restore(r.PathValue("id"), store.Now(), "web")
	if err == store.ErrNotFound {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, b)
}

func (a *API) handlePurge(w http.ResponseWriter, r *http.Request) {
	if err := a.Store.Purge(r.PathValue("id"), store.Now(), "web"); err != nil {
		if err == store.ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (a *API) handleMove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ParentID string  `json:"parentId"`
		Position float64 `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	b, err := a.Store.Move(r.PathValue("id"), body.ParentID, body.Position, store.Now(), "web")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, b)
}

func (a *API) handleReorder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ParentID string   `json:"parentId"`
		IDs      []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	if err := a.Store.Reorder(body.ParentID, body.IDs, store.Now(), "web"); err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

// handleBatch: one call for move/delete/tag on many ids.
func (a *API) handleBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs      []string `json:"ids"`
		Action   string   `json:"action"` // move | delete | restore | tag | untag | favorite | archive
		ParentID string   `json:"parentId,omitempty"`
		Tag      string   `json:"tag,omitempty"`
		Value    *bool    `json:"value,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	at := store.Now()
	affected := 0
	for _, id := range body.IDs {
		var err error
		switch body.Action {
		case "delete":
			_, err = func() ([]string, error) { return a.Store.DeleteSoft(id, at, "web") }()
		case "restore":
			_, err = a.Store.Restore(id, at, "web")
		case "move":
			_, err = a.Store.Move(id, body.ParentID, 0, at, "web")
		case "tag":
			cur, gerr := a.Store.Get(id)
			if gerr == nil {
				tags := append(cur.Tags, body.Tag)
				_, err = a.Store.SetTags(id, tags, "web")
			}
		case "untag":
			cur, gerr := a.Store.Get(id)
			if gerr == nil {
				var tags []string
				for _, t := range cur.Tags {
					if t != body.Tag {
						tags = append(tags, t)
					}
				}
				_, err = a.Store.SetTags(id, tags, "web")
			}
		case "favorite", "archive":
			cur, gerr := a.Store.Get(id)
			if gerr == nil {
				if body.Action == "favorite" {
					cur.Favorite = body.Value != nil && *body.Value
				} else {
					cur.Archived = body.Value != nil && *body.Value
				}
				cur.UpdatedAt = at
				cur.DeviceID = "web"
				_, _, err = a.Store.UpdateLWWBase(cur, nil, cur.Revision)
			}
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown action " + body.Action})
			return
		}
		if err != nil && err != store.ErrNotFound {
			httpError(w, http.StatusInternalServerError, err)
			return
		}
		affected++
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]any{"affected": affected})
}

func (a *API) handleSetTags(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad payload"})
		return
	}
	b, err := a.Store.SetTags(r.PathValue("id"), body.Tags, "web")
	if err == store.ErrNotFound {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, b)
}

func (a *API) handleListTags(w http.ResponseWriter, r *http.Request) {
	tags, err := a.Store.ListTags()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (a *API) handleRenameTag(w http.ResponseWriter, r *http.Request) {
	var body struct{ From, To string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.From == "" || body.To == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "from and to required"})
		return
	}
	n, err := a.Store.RenameTag(body.From, body.To)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]any{"affected": n})
}

func (a *API) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	var body struct{ Tag string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Tag == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tag required"})
		return
	}
	n, err := a.Store.DeleteTag(body.Tag)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	a.broadcastRevision()
	writeJSON(w, http.StatusOK, map[string]any{"affected": n})
}

func (a *API) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	res, err := a.Store.Search(q, limit)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (a *API) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := a.Store.Stats()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}
