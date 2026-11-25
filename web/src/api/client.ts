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
  const text = await resp.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = { raw: text } }
  }
  if (resp.status === 401) {
    // login/setup 401 = wrong credentials, NOT an expired session: broadcasting
    // md:unauthorized here showed "登录已过期" on a wrong password and bounced
    // the login page into a redirect loop. The auth endpoints surface their own
    // error text; only the authenticated API surface treats 401 as expiry.
    if (data && typeof data.error === 'string' && !window.location.pathname.startsWith('/login')) {
      window.dispatchEvent(new CustomEvent('md:unauthorized'))
      throw new ApiError(401, '登录已过期')
    }
    throw new ApiError(401, (data && data.error) || `HTTP ${resp.status}`)
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
  const text = await resp.text()
  let data: any = null
  if (text) { try { data = JSON.parse(text) } catch { data = { raw: text } } }
  if (resp.status === 401) {
    // import runs on an authenticated page: 401 here IS session expiry
    window.dispatchEvent(new CustomEvent('md:unauthorized'))
    throw new ApiError(401, '登录已过期')
  }
  if (!resp.ok) throw new ApiError(resp.status, (data && data.error) || `HTTP ${resp.status}`)
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  // binary download with auth/401 handling (export endpoints return files)
  getBlob: async (path: string): Promise<Blob> => {
    const headers: Record<string, string> = {}
    if (csrfToken) headers['X-CSRF'] = csrfToken
    const resp = await fetch(BASE + path, { headers, credentials: 'same-origin' })
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent('md:unauthorized'))
      throw new ApiError(401, '登录已过期')
    }
    if (!resp.ok) throw new ApiError(resp.status, `HTTP ${resp.status}`)
    return resp.blob()
  },
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
export interface Device { id: string; name: string; clientName?: string; createdAt: number; lastSeen: number; online?: boolean }
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
  newPairCode: (deviceName?: string) => api.post<{ code: string }>('/api/pair-code', deviceName ? { deviceName } : {}),
  getProxy: () => api.get<{ proxy: string }>('/api/network/proxy'),
  clearFavicons: () => api.post<{ ok: string; cleared: string }>('/api/favicon/clear', {}),
  setProxy: (proxy: string) => api.post<{ ok: string }>('/api/network/proxy', { proxy }),
  testProxy: (proxy: string) => api.post<{ ok: boolean; status?: number; ms?: number; error?: string }>('/api/network/proxy-test', { proxy }),
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
  folderDuplicates: () =>
    api.get<{ groups: { parentId: string; title: string; items: Bookmark[] }[] }>('/api/tools/folder-duplicates'),
  mergeFolderDup: (keepId: string, removeIds: string[]) =>
    api.post<{ moved: number }>('/api/tools/folder-duplicates/merge', { keepId, removeIds }),
  snapshots: () => api.get<{ snapshots: Snapshot[] }>('/api/snapshots'),
  createSnapshot: () => api.post<Snapshot>('/api/snapshots'),
  restoreSnapshot: (id: string) => api.post(`/api/snapshots/${id}/restore`),
}
