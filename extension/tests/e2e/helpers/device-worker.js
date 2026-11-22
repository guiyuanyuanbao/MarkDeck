// One device per process: runs the REAL extension bundle against its own
// chrome.* sandbox. The orchestrator spawns one worker per device and talks
// to them over stdin/stdout JSON lines. Devices communicate only through
// the real MarkDeck server over HTTP — exactly like real browsers.
'use strict'
const fs = require('fs')
const path = require('path')

const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8996'

class EventBus {
  constructor() { this.listeners = new Map() }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, [])
    this.listeners.get(evt).push(fn)
  }
  async emit(evt, ...args) {
    const ls = this.listeners.get(evt) || []
    for (const fn of ls) {
      // listener errors/stalls must not block the local bookmark operation
      await Promise.race([Promise.resolve(fn(...args)).catch(() => {}), new Promise(r => setTimeout(r, 8000))])
    }
  }
}

let nextId = 100
class BookmarkStore {
  constructor() {
    this.nodes = new Map()
    this.root = { id: '0', parentId: '', title: '', children: [] }
    this.nodes.set('0', this.root)
    const bar = { id: '1', parentId: '0', title: '书签栏', children: [], folderType: 'bookmarks' }
    this.nodes.set('1', bar)
    this.root.children.push(bar)
    this.events = new EventBus()
  }
  childrenOf(id) { return this.nodes.get(id)?.children || [] }
  async getTree() { return [this.root] }
  async getChildren(id) { return this.childrenOf(id).map(c => ({ ...c })) }
  async create(args) {
    if (!args) throw new Error('create: args undefined')
    console.error('[store.create] args=', JSON.stringify(args))
    const { parentId = '1', title = '', url, index } = args
    const parent = this.nodes.get(parentId)
    if (!parent) throw new Error('parent missing: ' + parentId)
    const node = { id: String(nextId++), parentId, title, url, index: index ?? parent.children.length, dateAdded: Date.now() }
    if (index === undefined) parent.children.push(node)
    else parent.children.splice(index, 0, node)
    this.nodes.set(node.id, node)
    await this.events.emit('onCreated', node.id, node)
    return { ...node }
  }
  async update(id, { title, url }) {
    console.error('[store.update] called id=' + id)
    const n = this.nodes.get(id)
    if (!n) { console.error('[store.update] no node', id); throw new Error('no node ' + id) }
    if (title !== undefined) n.title = title
    if (url !== undefined) n.url = url
    await this.events.emit('onChanged', id, { title: n.title, url: n.url })
    return { ...n }
  }
  async move(id, { parentId, index }) {
    const n = this.nodes.get(id)
    if (!n) throw new Error('no node ' + id)
    const oldParent = n.parentId
    const oldIndex = this.childrenOf(oldParent).findIndex(c => c.id === id)
    this.childrenOf(oldParent).splice(oldIndex, 1)
    const p = this.nodes.get(parentId)
    n.parentId = parentId
    n.index = index ?? p.children.length
    p.children.splice(n.index, 0, n)
    await this.events.emit('onMoved', id, { parentId, oldParentId: oldParent, index: n.index })
    return { ...n }
  }
  async removeTree(id) {
    const n = this.nodes.get(id)
    if (!n) throw new Error('no node ' + id)
    const oldParent = n.parentId
    const rm = (nid) => {
      const node = this.nodes.get(nid)
      for (const c of node.children || []) rm(c.id)
      this.nodes.delete(nid)
    }
    const idx = this.childrenOf(oldParent).findIndex(c => c.id === id)
    this.childrenOf(oldParent).splice(idx, 1)
    rm(id)
    await this.events.emit('onRemoved', id, { parentId: oldParent, index: idx })
  }
  async search(q) {
    const out = []
    for (const n of this.nodes.values()) {
      if (n.url && (n.title?.includes(q) || n.url.includes(q))) out.push({ ...n })
    }
    return out
  }
}

const device = (() => {
  const store = new BookmarkStore()
  const storage = new Map()
  const alarms = []
  const runtimeEvents = new EventBus()
  return {
    name: process.argv[2] || 'device',
    store,
    storage,
    alarms,
    runtimeEvents,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {}
            if (keys === null || keys === undefined) { for (const [k, v] of storage) out[k] = v; return out }
            for (const k of Array.isArray(keys) ? keys : [keys]) if (storage.has(k)) out[k] = storage.get(k)
            return out
          },
          async set(obj) { for (const [k, v] of Object.entries(obj)) storage.set(k, v) },
        },
      },
      bookmarks: {
        getTree: (...a) => store.getTree(...a),
        getChildren: (...a) => store.getChildren(...a),
        create: (...a) => store.create(...a),
        update: (...a) => store.update(...a),
        move: (...a) => store.move(...a),
        removeTree: (...a) => store.removeTree(...a),
        search: (...a) => store.search(...a),
        onCreated: { addListener: (fn) => store.events.on('onCreated', fn) },
        onChanged: { addListener: (fn) => store.events.on('onChanged', fn) },
        onMoved: { addListener: (fn) => store.events.on('onMoved', fn) },
        onRemoved: { addListener: (fn) => store.events.on('onRemoved', fn) },
        onChildrenReordered: { addListener: (fn) => store.events.on('onChildrenReordered', fn) },
      },
      alarms: {
        create: (n, info) => alarms.push({ name: n, info }),
        onAlarm: { addListener: (fn) => { alarms.fire = fn } },
      },
      runtime: {
        onInstalled: { addListener: (fn) => runtimeEvents.on('installed', fn) },
        onStartup: { addListener: (fn) => runtimeEvents.on('startup', fn) },
        onMessage: { addListener: (fn) => runtimeEvents.on('message', fn) },
        getManifest: () => ({ name: 'MarkDeck', version: 'test' }),
        lastError: null,
      },
      action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
      permissions: { request: async () => true },
    },
  }
})()

globalThis.chrome = device.chrome
// log all fetches the bundle makes
const __origFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
  if (url.includes('device-push') && args[1]?.body) console.error('[push-body]', args[1].body.slice(0, 300))
  return __origFetch(...args).then(r => { console.error('[fetch]', r.status, url); return r }, e => { console.error('[fetch-ERR]', url, e.message); throw e })
}

// block WS reconnect spam in the sandboxed bundle: the WS works in Node but
// we drive sync explicitly via resync messages, so a failed WS just retries.
// (Native WebSocket works fine; leaving as-is.)

async function main() {
  // load the REAL bundle (ESM)
  const src = path.join(__dirname, '..', '..', '..', 'dist', 'background.test.mjs')
  const url = 'file:///' + src.split(path.sep).join('/') + '?t=' + Date.now()
  await import(url)

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  send({ ready: true, name: device.name })

  const lines = []
  let buf = ''
  process.stdin.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    drain()
  })

  async function drain() {
    for (const line of lines.splice(0)) {
      let cmd
      try { cmd = JSON.parse(line) } catch { continue }
      if (process.env.MD_WORKER_DEBUG) console.error("[cmd]", device.name, cmd.type, cmd.id)
      try {
        let resultOf = null;
        const result = await Promise.race([
          (async () => {
        switch (cmd.type) {
          case 'pair': {
            // exact options-page flow: the bundle's own 'pair' message handler
            // does pairing + initial import + full sync + WS connect
            resultOf = await new Promise((resolve, reject) => {
              device.runtimeEvents.emit('message', { type: 'pair', server: SERVER, code: cmd.payload?.code ?? cmd.code, name: device.name }, {}, (resp) => {
                resp?.ok ? resolve(resp) : reject(new Error(resp?.error || 'pair failed'))
              })
            })
            break
          }
          case 'resync': {
            await new Promise((resolve) => device.runtimeEvents.emit('message', { type: 'resync' }, {}, resolve))
            const cfg = await device.chrome.storage.local.get('md_config')
            resultOf = { ok: true, rev: cfg.md_config?.rev }
            break
          }
          case 'create': {
            resultOf = await device.store.create(cmd.payload)
            break
          }
          case 'update': {
            resultOf = await device.store.update(cmd.payload?.id ?? cmd.id, cmd.payload?.patch)
            break
          }
          case 'removeTree': {
            await device.store.removeTree(cmd.payload?.id ?? cmd.id)
            resultOf = { ok: true }
            break
          }
          case 'titles': {
            const out = []
            for (const n of device.store.nodes.values()) if (n.url) out.push(n.title)
            resultOf = out
            break
          }
          case 'ids': {
            resultOf = [...device.store.nodes.keys()]
            break
          }
          case 'status': {
            const st = await device.chrome.storage.local.get(['md_status', 'md_config'])
            resultOf = { status: st.md_status, server: st.md_config?.server, deviceId: st.md_config?.deviceId }
            break
          }
          case 'findIdByTitle': {
            for (const [id, n] of device.store.nodes) {
              if (n.title === (cmd.payload?.title ?? cmd.title)) { resultOf = id; break }
            }
            break
          }
          case 'localIdOf': {
            // server id -> this device's local id (post-UUID-minting they differ)
            const st = await device.chrome.storage.local.get('md_id_map')
            resultOf = (st.md_id_map || {})[cmd.payload?.serverId ?? cmd.serverId] ?? null
            break
          }
          case 'setServer': {
            const st = await device.chrome.storage.local.get('md_config')
            if (st.md_config) {
              st.md_config.server = cmd.payload?.server ?? cmd.server
              await device.chrome.storage.local.set({ md_config: st.md_config })
            }
            resultOf = { ok: true }
            break
          }
          case 'queueLength': {
            const q = await device.chrome.storage.local.get('md_queue')
            resultOf = (q.md_queue || []).length
            break
          }
          case 'debugPull': {
            const cfg = await device.chrome.storage.local.get('md_config')
            const r = await fetch(SERVER + '/api/sync/device-pull?since=' + cfg.md_config.rev, {
              headers: { Authorization: 'Bearer ' + cfg.md_config.token },
            })
            const data = await r.json()
            const local = await device.chrome.storage.local.get('md_local_nodes')
            resultOf = {
              rev: cfg.md_config.rev,
              head: data.head,
              changes: data.changes?.map(c => ({ id: c.id, title: c.title, del: c.deletedAt, rev: c.revision, dev: c.deviceId.slice(0,8) })),
              localHas: Object.keys(local.md_local_nodes || {}).length,
              localIds: Object.keys(local.md_local_nodes || {}),
              queue: (await device.chrome.storage.local.get('md_queue')).md_queue?.map(q => ({ kind: q.kind, id: q.id, at: q.at, title: q.title })) || [],
            }
            break
          }
          case 'debugTree': {
            const dump = []
            for (const [id, n] of device.store.nodes) dump.push({ id, parentId: n.parentId, type: n.url ? 'url' : 'folder', title: n.title, url: n.url || undefined })
            resultOf = dump
            break
          }
          case 'debugLocalBar': {
            const bar = device.store.nodes.get('1')
            const walk = (n) => {
              const out = { title: n.title, url: n.url || undefined, children: [] }
              for (const c of n.children || []) out.children.push(walk(c))
              return out
            }
            resultOf = bar ? walk(bar) : null
            break
          }
          case 'config': {
            const st = await device.chrome.storage.local.get('md_config')
            resultOf = st.md_config || null
            break
          }
          case 'deleteByIdRemote': {
            // remove node on server by id (device-agnostic helper)
            const st = await device.chrome.storage.local.get('md_config')
            const r = await fetch(SERVER + '/api/sync/device-push', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.md_config.token },
              body: JSON.stringify([{ id: cmd.id, deletedAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), deviceId: 'admin' }]),
            })
            resultOf = { status: r.status }
            break
          }
          default:
            resultOf = { error: 'unknown cmd ' + cmd.type }
        }
        return resultOf
          })(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('worker cmd timeout: ' + cmd.type)), 12000)),
        ])
        console.error("[send]", device.name, cmd.type, cmd.id); send({ id: cmd.id, result })
      } catch (e) {
        console.error("[send-err]", device.name, cmd.type, e.message); send({ id: cmd.id, error: e.message })
      }
    }
  }
}

main().catch((e) => { console.error('WORKER_FATAL', e); process.exit(1) })
