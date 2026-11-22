// chrome.* stub sandbox that runs the REAL built extension code
// (dist/background.js) twice, each with its own isolated storage and
// bookmark tree — simulating two independent devices.
//
// It wires the same public surface the extension uses:
//   chrome.storage.local, chrome.bookmarks (tree + events), chrome.alarms,
//   chrome.runtime (onMessage/onInstalled), chrome.action badge, permissions.
// fetch is Node's native fetch (no stubbing needed).
'use strict'
const fs = require('fs')
const path = require('path')

class EventBus {
  constructor() { this.listeners = new Map() }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, [])
    this.listeners.get(evt).push(fn)
  }
  async emit(evt, ...args) {
    const ls = this.listeners.get(evt) || []
    for (const fn of ls) await fn(...args)
  }
}

// ---- in-memory bookmark tree, mirroring Chrome semantics ----
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
  async create({ parentId = '1', title = '', url, index }) {
    const parent = this.nodes.get(parentId)
    if (!parent) { console.error('[sandbox:create] parent missing:', parentId, 'title:', title); throw new Error('parent missing: ' + parentId) }
    const node = { id: String(nextId++), parentId, title, url, index: index ?? parent.children.length, dateAdded: Date.now() }
    if (index === undefined) parent.children.push(node)
    else parent.children.splice(index, 0, node)
    this.nodes.set(node.id, node)
    await this.events.emit('onCreated', node.id, node)
    return { ...node }
  }
  async update(id, { title, url }) {
    const n = this.nodes.get(id)
    if (!n) throw new Error('no node ' + id)
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

// ---- one device sandbox ----
function createDevice(name, serverBase) {
  const store = new BookmarkStore()
  const storage = new Map()
  const alarms = []
  const runtimeEvents = new EventBus()
  const messages = [] // recorded sendResponse results

  const chrome = {
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
      sendMessage: async (msg) => new Promise(resolve => {
        // route to the device's own onMessage listener
        runtimeEvents.emit('message', msg, {}, (resp) => resolve(resp))
      }),
      lastError: null,
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
    permissions: {
      request: async () => true,
    },
  }
  // extension message responses come back via sendResponse callback
  runtimeEvents.on('message', (msg, sender, sendResponse) => {
    messages.push({ msg, ts: Date.now() })
  })

  const device = { name, chrome, store, storage, alarms, runtimeEvents, serverBase }
  return device
}

// runExtensionCode is async now: the bundle is an ES module.
async function runExtensionCode(device) {
  globalThis.chrome = device.chrome
  const src = path.join(__dirname, '..', '..', 'dist', 'background.js')
  const url = 'file:///' + src.split(path.sep).join('/') + '?t=' + Date.now()
  await import(url)
}

module.exports = { createDevice, runExtensionCode, BookmarkStore }
