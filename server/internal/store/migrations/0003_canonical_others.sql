-- 0003: canonical 其他书签 folder + per-device holder merge
--
-- The old extension minted an others-<deviceId> holder folder per device
-- (client-side id 'others-<deviceId>'), which made cross-device Other
-- Bookmarks semantics wrong by construction. This migration creates ONE
-- canonical holder (fixed id 'md-others') and hard-merges every holder's
-- children into it, deduping by normalized URL. Holders themselves are
-- deleted outright (destructive refactor, approved 2026-11-24).
--
-- URL normalization here is a simple lower-case + trailing-slash trim,
-- matching the dedupe granularity the old import merge used for same-fold-
-- er content. The Go-side migration runner performs the tree merge (parent
-- relinking needs ordered traversal), so this file only creates the holder.

INSERT INTO bookmarks
    (id, parent_id, type, title, url, note, favorite, archived, position,
     deleted_at, purged, updated_at, device_id, created_at)
SELECT 'md-others', '', 'folder', '其他书签', '', '', 0, 0, 9999,
       0, 0, strftime('%s','now'), 'migration', strftime('%s','now')
WHERE NOT EXISTS (SELECT 1 FROM bookmarks WHERE id = 'md-others');
