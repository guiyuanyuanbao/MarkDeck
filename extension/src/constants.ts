// Shared constants for the extension. background.ts defined the storage
// keys while options.ts/popup.ts hardcoded the same strings — one drift-
// prone pattern the refactor collapsed into this single module.
//
// NOTE: import cycles are fine here (constants only), and vite bundles
// background/options/popup separately, each tree-shaking what it uses.

// chrome.storage.local keys (single source of truth)
export const CONFIG_KEY = 'md_config'
export const BASE_KEY = 'md_base'
export const TOUCH_KEY = 'md_touch'
export const STATUS_KEY = 'md_status'
// pre-0.1.0 keys — removed once on upgrade
export const LEGACY_KEYS = ['md_queue', 'md_local_nodes', 'md_id_map', 'md_l2s']

export const SYNC_ALARM = 'md-poll'

// The device name shown in the admin UI's device list. Chrome vs Edge is
// decided by the UA; /Edg\// is the engine token (options.ts used to match
// a bare 'Edg' substring which a renamed UA could spoof).
export function browserDisplayName(): string {
  return /Edg\//.test(navigator.userAgent) ? 'Edge 浏览器' : 'Chrome 浏览器'
}

// apiBase normalizes a server URL to a fetchable origin (no trailing slash).
export function apiBase(server: string): string {
  return server.replace(/\/+$/, '')
}

// Outbound request timeouts (ms). One place so tightening/tuning doesn't
// require hunting magic numbers across three entry points.
export const TIMEOUTS = {
  // quick reachability probe before pairing
  stateProbe: 8000,
  // pairing round-trip (exchange + initial import + full sync)
  pair: 15000,
  // single /api/sync/tree or /api/sync/apply call
  syncCall: 30000,
  // chrome._favicon/ page fetch
  faviconFetch: 5000,
  // favicon PUT upload
  faviconPut: 8000,
} as const
