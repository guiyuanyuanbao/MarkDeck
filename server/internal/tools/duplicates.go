// Duplicate detection and merge for URL bookmarks (URL-keyed) and same-name
// folders (parent+title-keyed). Merge keeps one row, soft-deletes the rest.
package tools

import (
	"fmt"
	"sort"
	"strings"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// ---- duplicates ----

// DupGroup is one normalized URL shared by >=2 live bookmarks.
type DupGroup struct {
	Key   string            `json:"key"`
	Items []*store.Bookmark `json:"items"`
}

// FindDuplicates groups live URL bookmarks by normalized URL (same rules as
// import dedupe: tracking params stripped, www/scheme ignored).
// FolderDupGroup is a set of same-named folders under the same parent —
// artifacts of the multi-device initial-import bug (each device pushed its
// own folder tree before UUID adoption existed).
type FolderDupGroup struct {
	ParentID string            `json:"parentId"`
	Title    string            `json:"title"`
	Items    []*store.Bookmark `json:"items"`
}

// FindFolderDuplicates groups live folders by (parent, title).
func (c *Chain) FindFolderDuplicates() ([]FolderDupGroup, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	groups := map[string][]*store.Bookmark{}
	var order []string
	for _, n := range nodes {
		if n.Type != "folder" {
			continue
		}
		// 其他书签 holders are per-device buckets, not user duplicates —
		// exclude them by their stable id prefix instead of by parent
		// (the user's duplicated folders live at top level!)
		if strings.HasPrefix(n.ID, "others-") {
			continue
		}
		key := n.ParentID + "\x00" + strings.TrimSpace(n.Title)
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], n)
	}
	var out []FolderDupGroup
	for _, k := range order {
		items := groups[k]
		if len(items) >= 2 {
			parts := strings.SplitN(k, "\x00", 2)
			out = append(out, FolderDupGroup{ParentID: parts[0], Title: parts[1], Items: items})
		}
	}
	return out, nil
}

// MergeFolderDuplicates merges a duplicate-folder group: every child of each
// removed folder moves into the kept folder (deduped by url|title within the
// target), then the shells are trashed. Children of children follow their
// parent, so deep subtrees move intact.
func (c *Chain) MergeFolderDuplicates(keepID string, removeIDs []string) (moved int, err error) {
	keep, err := c.Store.Get(keepID)
	if err != nil {
		return 0, err
	}
	if keep.Type != "folder" {
		return 0, fmt.Errorf("keepID must be a folder")
	}
	at := store.Now()
	for _, id := range removeIDs {
		rm, err := c.Store.Get(id)
		if err != nil {
			continue
		}
		if rm.Type != "folder" || rm.DeletedAt > 0 {
			continue
		}
		// re-parent every live child into the kept folder
		kids, err := c.Store.Children(id)
		if err != nil {
			return moved, err
		}
		// build the target's existing url|title set for dedup
		targetKids, err := c.Store.Children(keepID)
		if err != nil {
			return moved, err
		}
		seen := map[string]bool{}
		for _, tk := range targetKids {
			if tk.URL != "" {
				seen[strings.TrimRight(tk.URL, "/")+"|"+tk.Title] = true
			}
		}
		pos := float64(len(targetKids))
		for _, kid := range kids {
			// url children that already exist (url|title) in the target are
			// dropped along with their subtree; folders always move
			if kid.URL != "" && seen[strings.TrimRight(kid.URL, "/")+"|"+kid.Title] {
				if _, err := c.Store.DeleteSoft(kid.ID, at, "tools"); err != nil {
					return moved, err
				}
				continue
			}
			if _, err := c.Store.Move(kid.ID, keepID, pos+1, at, "tools"); err != nil {
				return moved, err
			}
			pos++
			moved++
			if kid.URL != "" {
				seen[strings.TrimRight(kid.URL, "/")+"|"+kid.Title] = true
			}
		}
		// shell is now empty — trash it (subtree was already moved out)
		if _, err := c.Store.DeleteSoft(id, at, "tools"); err != nil {
			return moved, err
		}
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return moved, nil
}

// ValidateDuplicateGroup confirms keep+remove ids really belong to one
// duplicate-URL group (same normalized key, ≥2 members). Merge deletes its
// inputs, so without this the endpoint was an arbitrary-delete primitive.
func (c *Chain) ValidateDuplicateGroup(keepID string, removeIDs []string) error {
	nodes, err := c.Store.Tree()
	if err != nil {
		return err
	}
	byID := map[string]*store.Bookmark{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	keep, ok := byID[keepID]
	if !ok || keep.Type != "url" {
		return fmt.Errorf("keepId %s is not a live url bookmark", keepID)
	}
	key := normalizeForDup(keep.URL)
	for _, rid := range removeIDs {
		rm, ok := byID[rid]
		if !ok || rm.Type != "url" || normalizeForDup(rm.URL) != key {
			return fmt.Errorf("removeId %s is not a duplicate of the keep bookmark", rid)
		}
	}
	return nil
}

// ValidateFolderDuplicateGroup confirms keep+remove are same-parent
// same-title folder groups — the only shape MergeFolderDuplicates may
// consume (same arbitrary-delete concern as ValidateDuplicateGroup).
func (c *Chain) ValidateFolderDuplicateGroup(keepID string, removeIDs []string) error {
	nodes, err := c.Store.Tree()
	if err != nil {
		return err
	}
	byID := map[string]*store.Bookmark{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	keep, ok := byID[keepID]
	if !ok || keep.Type != "folder" {
		return fmt.Errorf("keepId %s is not a live folder", keepID)
	}
	for _, rid := range removeIDs {
		rm, ok := byID[rid]
		if !ok || rm.Type != "folder" || rm.ParentID != keep.ParentID || rm.Title != keep.Title {
			return fmt.Errorf("removeId %s is not a same-folder duplicate of the keep folder", rid)
		}
	}
	return nil
}

func (c *Chain) FindDuplicates() ([]DupGroup, error) {
	nodes, err := c.Store.Tree()
	if err != nil {
		return nil, err
	}
	groups := map[string][]*store.Bookmark{}
	for _, n := range nodes {
		if n.Type != "url" || n.URL == "" {
			continue
		}
		key := normalizeForDup(n.URL)
		groups[key] = append(groups[key], withFilteredTags(n))
	}
	var out []DupGroup
	for k, items := range groups {
		if len(items) >= 2 {
			sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt < items[j].CreatedAt })
			out = append(out, DupGroup{Key: k, Items: items})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// normalizeForDup mirrors importexport.normURL but without the import
// package dependency (kept in lockstep by test).
func normalizeForDup(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	i := strings.Index(raw, "://")
	scheme, rest := "", raw
	if i > 0 {
		scheme = strings.ToLower(raw[:i+3])
		rest = raw[i+3:]
	}
	host := rest
	path := "/"
	if j := strings.IndexAny(rest, "/?#"); j >= 0 {
		host = rest[:j]
		path = rest[j:]
	}
	host = strings.ToLower(host)
	host = strings.TrimPrefix(host, "www.")
	if q := strings.Index(path, "?"); q >= 0 {
		query := path[q+1:]
		frag := ""
		if f := strings.Index(query, "#"); f >= 0 {
			frag = query[f:]
			query = query[:f]
		}
		var keep []string
		for _, kv := range strings.Split(query, "&") {
			k := strings.ToLower(kv)
			if idx := strings.Index(k, "="); idx >= 0 {
				k = k[:idx]
			}
			if trackingParam(k) {
				continue
			}
			keep = append(keep, kv)
		}
		path = path[:q]
		if len(keep) > 0 {
			path += "?" + strings.Join(keep, "&")
		}
		path += frag
	}
	if path == "/" {
		path = ""
	}
	return scheme + host + path
}

func trackingParam(k string) bool {
	switch k {
	case "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
		"utm_id", "fbclid", "gclid", "ref", "ref_src", "spm", "share_token", "share_source":
		return true
	}
	return false
}

// MergeDuplicate keeps the preferred bookmark (first by createdAt) and moves
// others to trash, merging their tags into the survivor.
func (c *Chain) MergeDuplicate(keepID string, removeIDs []string) error {
	keep, err := c.Store.Get(keepID)
	if err != nil {
		return err
	}
	at := store.Now()
	for _, id := range removeIDs {
		rm, err := c.Store.Get(id)
		if err != nil {
			continue
		}
		// absorb tags + note
		merged := map[string]bool{}
		for _, t := range keep.Tags {
			merged[t] = true
		}
		newTags := keep.Tags
		for _, t := range rm.Tags {
			if !strings.HasPrefix(t, "_") && !merged[t] {
				newTags = append(newTags, t)
			}
		}
		if keep.Note == "" && rm.Note != "" {
			keep.Note = rm.Note
		}
		if len(newTags) != len(keep.Tags) || keep.Note != rm.Note && rm.Note != "" {
			keep.Tags = newTags
		}
		keep.UpdatedAt = at
		keep.DeviceID = "tools"
		if _, _, err := c.Store.UpdateLWWBase(keep, newTags, keep.Revision); err != nil {
			return err
		}
		// move duplicate to trash
		if _, err := c.Store.DeleteSoft(id, at, "tools"); err != nil {
			return err
		}
	}
	if c.Broadcast != nil {
		c.Broadcast(0)
	}
	return nil
}
