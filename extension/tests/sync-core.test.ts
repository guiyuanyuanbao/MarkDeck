import { describe, it, expect } from 'vitest'
import {
  compressQueue, opsToPushPayload, clientWins, planRemoteActions,
  backoffDelay, isOfflineState, detectDuplicateGroups, type NodeState, type QueuedOp,
} from '../src/sync-core'

const T = 1700000000

function node(p: Partial<NodeState> = {}): NodeState {
  return {
    id: 'n1', parentId: '', type: 'url', title: 'A', url: 'https://a',
    position: 1, revision: 1, updatedAt: T, deviceId: 'd1', createdAt: T, ...p,
  }
}

describe('compressQueue', () => {
  it('keeps only the last op per id', () => {
    const ops: QueuedOp[] = [
      { kind: 'created', id: 'a', at: 1 },
      { kind: 'changed', id: 'a', title: 'x', at: 2 },
      { kind: 'created', id: 'b', at: 3 },
    ]
    const out = compressQueue(ops)
    expect(out.map((o) => o.id).sort()).toEqual(['a', 'b'])
    // created+changed merge: surviving op keeps creation fields, latest title
    const a = out.find((o) => o.id === 'a')!
    expect(a.kind).toBe('created')
    expect(a.title).toBe('x')
  })
})

describe('opsToPushPayload', () => {
  it('maps created ops to server create shape', () => {
    const payload = opsToPushPayload(
      [{ kind: 'created', id: 'x', parentId: 'p', title: 'T', url: 'https://x', index: 2, at: T }],
      'dev-1', new Map())
    expect(payload[0]).toMatchObject({
      id: 'x', type: 'url', parentId: 'p', title: 'T', position: 3, deviceId: 'dev-1',
    })
  })
  it('removed ops carry deletedAt for tombstone', () => {
    const payload = opsToPushPayload([{ kind: 'removed', id: 'x', at: T + 5 }], 'dev-1', new Map())
    expect(payload[0]).toMatchObject({ id: 'x', deletedAt: T + 5 })
  })
})

describe('clientWins (LWW mirror)', () => {
  it('remote newer wins', () => {
    const local = node({ updatedAt: T })
    const remote = node({ updatedAt: T + 5, deviceId: 'd2' })
    expect(clientWins(local, remote)).toBe(false)
  })
  it('local newer wins', () => {
    const local = node({ updatedAt: T + 10 })
    const remote = node({ updatedAt: T, deviceId: 'd2' })
    expect(clientWins(local, remote)).toBe(true)
  })
  it('tie broken by higher deviceId', () => {
    const local = node({ updatedAt: T, deviceId: 'aaa' })
    const remote = node({ updatedAt: T, deviceId: 'zzz' })
    expect(clientWins(local, remote)).toBe(false)
    expect(clientWins({ ...local, deviceId: 'zzz' }, { ...remote, deviceId: 'aaa' })).toBe(true)
  })
  it('unknown local -> remote wins', () => {
    expect(clientWins(undefined, node())).toBe(false)
  })
})

describe('planRemoteActions', () => {
  it('create for unknown node', () => {
    const acts = planRemoteActions([node({ id: 'new' })], new Map())
    expect(acts).toEqual([{ action: 'create', node: expect.objectContaining({ id: 'new' }) }])
  })
  it('remove for locally-present node that got deleted remotely', () => {
    const local = new Map([['n1', node()]])
    const acts = planRemoteActions([node({ deletedAt: T + 1 })], local)
    expect(acts[0].action).toBe('remove')
  })
  it('ignore stale local (local newer)', () => {
    const local = new Map([['n1', node({ updatedAt: T + 100 })]])
    const acts = planRemoteActions([node({ title: 'remote-newer-title?' })], local)
    expect(acts[0]).toMatchObject({ action: 'ignore', why: 'local newer' })
  })
  it('update+move when remote older wins and fields differ', () => {
    const local = new Map([['n1', node({ updatedAt: T - 10, parentId: 'old', position: 9, title: 'old' })]])
    const acts = planRemoteActions([node({ parentId: 'newp', position: 2, title: 'newer' })], local)
    const kinds = acts.map((a) => a.action)
    expect(kinds).toContain('update')
    expect(kinds).toContain('move')
    const move = acts.find((a) => a.action === 'move') as any
    expect(move.parentId).toBe('newp')
    expect(move.index).toBe(1) // position 2 -> index 1
  })
  it('skips self echo (no actions at all)', () => {
    const acts = planRemoteActions([node({ deviceId: '__self__' })], new Map([['n1', node()]]))
    expect(acts).toHaveLength(0)
  })
})

describe('backoff + offline', () => {
  it('caps at 30s and jitters', () => {
    for (const attempt of [0, 3, 10, 50]) {
      const d = backoffDelay(attempt)
      expect(d).toBeLessThanOrEqual(30000 * 1.25)
      expect(d).toBeGreaterThan(0)
    }
  })
  it('offline when disconnected or never connected', () => {
    expect(isOfflineState(null)).toBe(true)
    expect(isOfflineState('disconnected')).toBe(true)
    expect(isOfflineState('online')).toBe(false)
  })
})

describe('detectDuplicateGroups', () => {
  it('detects exact duplicates produced by double-sync', () => {
    const nodes = [
      { id: 'a', title: '重复页', url: 'https://dup.test/page' },
      { id: 'b', title: '重复页', url: 'https://dup.test/page' },
      { id: 'c', title: '正常页', url: 'https://ok.test' },
    ]
    const groups = detectDuplicateGroups(nodes)
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
    expect(groups[0].title).toBe('重复页')
  })
  it('ignores folders and unique bookmarks', () => {
    const groups = detectDuplicateGroups([
      { id: 'f', title: 'folder', url: undefined },
      { id: 'a', title: 'unique', url: 'https://a.test' },
    ])
    expect(groups).toHaveLength(0)
  })
  it('sorts by count descending', () => {
    const groups = detectDuplicateGroups([
      { id: 'a', title: 'x', url: 'https://x.test' },
      { id: 'b', title: 'x', url: 'https://x.test' },
      { id: 'c', title: 'y', url: 'https://y.test' },
      { id: 'd', title: 'y', url: 'https://y.test' },
      { id: 'e', title: 'y', url: 'https://y.test' },
    ])
    expect(groups[0].count).toBe(3)
    expect(groups[1].count).toBe(2)
  })
})
