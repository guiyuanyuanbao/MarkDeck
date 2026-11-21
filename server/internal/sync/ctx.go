package sync

import (
	"context"
	"time"
)

// timeoutCtx adapts a context.Context-compatible type for websocket writes
// without pulling extra deps beyond stdlib usage already present.
type timeoutCtx struct {
	deadline time.Time
	done     chan struct{}
}

func newTimeoutCtx(d time.Duration) timeoutCtx {
	return timeoutCtx{
		deadline: time.Now().Add(d),
		done:     make(chan struct{}),
	}
}

func (c timeoutCtx) Deadline() (time.Time, bool) { return c.deadline, true }
func (c timeoutCtx) Done() <-chan struct{}       { return c.done }
func (c timeoutCtx) Err() error                  { return nil }
func (c timeoutCtx) Value(key any) any           { return nil }

var _ context.Context = timeoutCtx{}
