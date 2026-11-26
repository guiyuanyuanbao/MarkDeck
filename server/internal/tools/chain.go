// Package tools implements maintenance utilities: dead-link scanning,
// duplicate detection and JSON snapshots with retention.
//
// This file holds the shared Chain type; deadlinks.go, duplicates.go and
// snapshots.go each carry one tool's implementation.
package tools

import (
	"os"
	"sync"

	"github.com/guiyuanyuanbao/MarkDeck/server/internal/store"
)

// Chain bundles the three maintenance tools sharing one store.
type Chain struct {
	Store       *store.Store
	SnapshotDir string
	Broadcast   func(int64)

	// scan state
	mu          sync.Mutex
	deadRunning bool
	lastDeadAt  int64
}

// NewChain wires a Chain.
func NewChain(st *store.Store, snapshotDir string, broadcast func(int64)) *Chain {
	_ = os.MkdirAll(snapshotDir, 0o700)
	c := &Chain{Store: st, SnapshotDir: snapshotDir, Broadcast: broadcast}
	// migration 0005 moved dead-link state to its own table; scrub the
	// pseudo-tags legacy scans left on bookmarks (one-time, cheap)
	go c.PurgeLegacyDeadTags()
	return c
}
