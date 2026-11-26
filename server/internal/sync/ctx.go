package sync

// The websocket write deadline is applied per-write in HandleWS via
// context.WithTimeout on the request context (see the writer pump in
// hub.go). History: the pre-0.1.17 timeoutCtx struct had Done() returning a
// never-closed channel and Err() always nil, so coder/websocket's select on
// Done never fired and the 5s write timeout was not actually enforced.
