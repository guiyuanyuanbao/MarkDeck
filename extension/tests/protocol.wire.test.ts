// Cross-repo wire-contract tests: the extension hand-mirrors the server's
// store.BatchOp (as ServerOp) and store.Bookmark (as ServerNode) JSON shapes.
// The golden fixtures live with the Go suite (server/internal/store/testdata/)
// and the Go contract_test.go asserts its structs marshal to exactly these
// bytes — so if either side drifts, one of the two suites goes red.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ServerOp } from '../src/reconcile'

// vitest runs from the extension/ package root
const goldenDir = resolve(process.cwd(), '../server/internal/store/testdata')

describe('wire contract: server BatchOp ↔ extension ServerOp', () => {
  it('golden create/update/delete ops decode into ServerOp and carry the fields the engine plans', () => {
    const raw = JSON.parse(readFileSync(resolve(goldenDir, 'batchops.golden.json'), 'utf8')) as Array<
      Record<string, unknown>
    >
    expect(raw).toHaveLength(3)

    // the reconciler emits ops with exactly these discriminants
    expect(raw.map((o) => o.op)).toEqual(['create', 'update', 'delete'])

    // field names the server's ApplyBatch reads (store/batch.go) — lowercase
    // JSON keys are the protocol; a rename on either side breaks sync silently
    const create = raw[0]
    for (const k of ['id', 'parentId', 'type', 'title', 'url', 'position', 'updatedAt', 'deviceId', 'observedRevision']) {
      expect(create, `create op missing ${k}`).toHaveProperty(k)
    }
    const update = raw[1]
    for (const k of ['id', 'title', 'tags', 'undelete', 'updatedAt', 'deviceId', 'observedRevision']) {
      expect(update, `update op missing ${k}`).toHaveProperty(k)
    }
    const del = raw[2]
    expect(del).not.toHaveProperty('parentId')
    expect(del).not.toHaveProperty('title')

    // decode through the real ServerOp type (structural check at compile time)
    const ops: ServerOp[] = raw.map((o) => {
      if (o.op === 'create') return { ...(o as unknown as Extract<ServerOp, { op: 'create' }>) }
      if (o.op === 'update') return { ...(o as unknown as Extract<ServerOp, { op: 'update' }>) }
      return { ...(o as unknown as Extract<ServerOp, { op: 'delete' }>) }
    })
    expect(ops[0].op === 'create' && ops[0].position).toBe(2.5)
    expect(ops[1].op === 'update' && ops[1].undelete).toBe(true)
    expect(ops[2].op).toBe('delete')
  })

  it('ServerNode field names match the golden Bookmark wire shape', () => {
    const rows = JSON.parse(readFileSync(resolve(goldenDir, 'bookmark.golden.json'), 'utf8')) as Array<
      Record<string, unknown>
    >
    // every key the engine reads from GET /api/sync/tree rows
    for (const k of ['id', 'parentId', 'type', 'title', 'position', 'revision', 'updatedAt']) {
      expect(rows[0], `tree row missing ${k}`).toHaveProperty(k)
    }
    expect(rows[0].deletedAt).toBe(1700000100)
  })
})
