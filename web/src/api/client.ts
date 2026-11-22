// API client: fetch wrapper with CSRF header injection and 401 handling.
const BASE = ''

let csrfToken = ''
export function setCsrf(token: string) { csrfToken = token }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrfToken) headers['X-CSRF'] = csrfToken

  const resp = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (resp.status === 401) {
    // session expired: broadcast so router can bounce to /login
    window.dispatchEvent(new CustomEvent('md:unauthorized'))
    throw new ApiError(401, '登录已过期')
  }
  const text = await resp.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = { raw: text } }
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, (data && data.error) || `HTTP ${resp.status}`)
  }
  return data as T
}

export async function uploadFile<T = any>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  const headers: Record<string, string> = {}
  if (csrfToken) headers['X-CSRF'] = csrfToken
  const resp = await fetch(BASE + path, { method: 'POST', headers, credentials: 'same-origin', body: fd })
  if (resp.status === 401) {
    window.dispatchEvent(new CustomEvent('md:unauthorized'))
    throw new ApiError(401, '登录已过期')
  }
  const text = await resp.text()
  let data: any = null
  if (text) { try { data = JSON.parse(text) } catch { data = { raw: text } } }
  if (!resp.ok) throw new ApiError(resp.status, (data && data.error) || `HTTP ${resp.status}`)
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ---- shared types mirroring server models ----
export interface Bookmark {
  id: string
  parentId: string
  type: 'folder' | 'url'
  title: string
  url?: string
  note?: string
  favorite: boolean
  archived: boolean
  position: number
  deletedAt?: number
  purged?: boolean
  revision: number
  updatedAt: number
  deviceId?: string
  createdAt: number
  tags?: string[]
}

export interface TagInfo { tag: string; count: number }
export interface Device { id: string; name: string; createdAt: number; lastSeen: number }
export interface Snapshot { id: string; createdAt: number; size: number; file: string; cause: string }

export const bookmarksApi = {
  tree: () => api.get<{ nodes: Bookmark[] }>('/api/bookmarks/tree'),
  create: (b: Partial<Bookmark> & { type: string; tags?: string[] }) =>
    api.post<Bookmark>('/api/bookmarks', b),
  update: (id: string, patch: Record<string, unknown>) =>
    api.put<Bookmark>(`/api/bookmarks/${id}`, patch),
  remove: (id: string) => api.del<{ deleted: string[] }>(`/api/bookmarks/${id}`),
  restore: (id: string) => api.post<Bookmark>(`/api/bookmarks/${id}/restore`),
  purge: (id: string) => api.post(`/api/bookmarks/${id}/purge`),
  batch: (payload: { ids: string[]; action: string; parentId?: string; tag?: string; value?: boolean }) =>
    api.post<{ affected: number }>('/api/bookmarks/batch', payload),
  setTags: (id: string, tags: string[]) => api.put<Bookmark>(`/api/bookmarks/${id}/tags`, { tags }),
  move: (id: string, parentId: string, position: number) =>
    api.post<Bookmark>(`/api/bookmarks/${id}/move`, { parentId, position }),
  reorder: (parentId: string, ids: string[]) =>
    api.post('/api/bookmarks/reorder', { parentId, ids }),
  trash: () => api.get<{ nodes: Bookmark[] }>('/api/trash'),
  search: (q: string, limit = 50) =>
    api.get<{ results: Bookmark[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  tags: () => api.get<{ tags: TagInfo[] }>('/api/tags'),
  renameTag: (from: string, to: string) => api.post<{ affected: number }>('/api/tags/rename', { from, to }),
  deleteTag: (tag: string) => api.post<{ affected: number }>('/api/tags/delete', { tag }),
  stats: () => api.get<Record<string, number>>('/api/stats'),
}

export const authApi = {
  state: () => api.get<{ setup: boolean; totp: boolean }>('/api/auth/state'),
  setup: (password: string) => api.post<{ csrf: string }>('/api/auth/setup', { password }),
  login: (password: string, totp = '') => api.post<{ csrf: string }>('/api/auth/login', { password, totp }),
  logout: () => api.post('/api/auth/logout'),
  me: () => api.get<{ admin: boolean; totp: boolean; csrf?: string }>('/api/auth/me'),
  changePassword: (oldPw: string, newPw: string) => api.post('/api/auth/change-password', { old: oldPw, new: newPw }),
  totpSetup: () => api.get<{ secret: string; otpauth: string }>('/api/auth/totp-setup'),
  totpEnable: (code: string) => api.post('/api/auth/totp-enable', { code }),
  totpDisable: () => api.post('/api/auth/totp-disable'),
  newPairCode: () => api.post<{ code: string }>('/api/pair-code'),
  devices: () => api.get<{ devices: Device[] }>('/api/devices'),
  revokeDevice: (id: string) => api.del(`/api/devices/${id}`),
}

export const toolsApi = {
  deadLinks: () => api.get<{ links: { bookmark: Bookmark; status: string; checked: number }[] }>('/api/tools/deadlinks'),
  scanDead: () => api.post('/api/tools/deadlinks/scan'),
  scanStatus: () => api.get<{ running: boolean; lastScanAt: number }>('/api/tools/deadlinks/status'),
  duplicates: () => api.get<{ groups: { key: string; items: Bookmark[] }[] }>('/api/tools/duplicates'),
  mergeDup: (keepId: string, removeIds: string[]) =>
    api.post('/api/tools/duplicates/merge', { keepId, removeIds }),
  snapshots: () => api.get<{ snapshots: Snapshot[] }>('/api/snapshots'),
  createSnapshot: () => api.post<Snapshot>('/api/snapshots'),
  restoreSnapshot: (id: string) => api.post(`/api/snapshots/${id}/restore`),
}
