// Package sync implements the real-time fan-out hub: authenticated
// WebSocket connections receive a revision ping whenever the global
// change counter moves, then pull the increment via REST.
package sync

import (
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Hub tracks live connections and broadcasts revision pings.
type Hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

type client struct {
	conn *websocket.Conn
	send chan int64
}

// NewHub returns an empty hub.
func NewHub() *Hub {
	return &Hub{clients: map[*client]struct{}{}}
}

const (
	writeTimeout = 5 * time.Second
	maxConnLife  = 12 * time.Hour
)

// HandleWS upgrades /api/ws and pumps pings until close. authenticate is
// called with the request (cookies/headers) before accepting the socket;
// when it returns false the socket is rejected with 401.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request, authenticate func(*http.Request) bool) {
	if !authenticate(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The extension's service worker connects from a chrome-extension://
		// origin that can never match the server host, and auth is done via
		// the device token (or session cookie) below the upgrade — so the
		// default same-origin Origin check must be disabled.
		OriginPatterns:  []string{"*"},
		CompressionMode: websocket.CompressionNoContextTakeover,
	})
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan int64, 8)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	// Writer pump.
	go func() {
		defer conn.Close(websocket.StatusGoingAway, "")
		current := int64(0)
		for {
			select {
			case rev := <-c.send:
				if rev <= current {
					continue
				}
				current = rev
				ctx := writeTimeoutContext()
				if err := conn.Write(ctx, websocket.MessageText, []byte(`{"t":"rev","rev":`+itoa(rev)+`}`)); err != nil {
					return
				}
			case <-r.Context().Done():
				return
			case <-time.After(maxConnLife):
				// Recycle long-lived connections so a dead TCP peer can't linger.
				return
			}
		}
	}()

	// Reader pump: consume (and ignore) client pongs/keepalives.
	for {
		_, _, err := conn.Read(r.Context())
		if err != nil {
			break
		}
	}
}

// Broadcast notifies every connected client of a new revision.
func (h *Hub) Broadcast(rev int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- rev:
		default: // slow client: drop; its alarm-poll fallback will catch up
		}
	}
}

func writeTimeoutContext() (ctx timeoutCtx) {
	return newTimeoutCtx(writeTimeout)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
