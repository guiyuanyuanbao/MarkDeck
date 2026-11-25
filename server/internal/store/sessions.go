package store

import (
	"database/sql"
	"strings"
)

// SessionRow is a stored session (token already hashed).
type SessionRow struct {
	ID   string
	CSRF string
}

// InsertSession stores a new session.
func (s *Store) InsertSession(idHash, csrf string, createdAt, expiresAt int64) error {
	_, err := s.DB.Exec(`INSERT INTO sessions(id, csrf, created_at, expires_at) VALUES(?,?,?,?)`,
		idHash, csrf, createdAt, expiresAt)
	return err
}

// ValidSession returns the session when present and unexpired.
func (s *Store) ValidSession(idHash string, now int64) (*SessionRow, bool) {
	row := s.DB.QueryRow(`SELECT csrf FROM sessions WHERE id=? AND expires_at > ?`, idHash, now)
	var csrf string
	if err := row.Scan(&csrf); err != nil {
		return nil, false
	}
	return &SessionRow{ID: idHash, CSRF: csrf}, true
}

// DeleteSession removes one session.
func (s *Store) DeleteSession(idHash string) error {
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE id=?`, idHash)
	return err
}

// DeleteAllSessions invalidates every login (used after password change).
func (s *Store) DeleteAllSessions() error {
	_, err := s.DB.Exec(`DELETE FROM sessions`)
	return err
}

// CleanupSessions drops expired rows.
func (s *Store) CleanupSessions(now int64) error {
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, now)
	return err
}

// ---- devices ----

// DeviceRow is a paired extension client.
type DeviceRow struct {
	ID         string
	Name       string // authoritative: the admin's pre-bound name, or the client's
	ClientName string // what the client called itself (context when a bound name exists)
	CreatedAt  int64
	LastSeen   int64
}

// CreateDevice registers a device by token hash. clientName is what the
// extension self-reported (may be empty).
func (s *Store) CreateDevice(tokenHash, name, clientName string) (string, error) {
	id, err := NewUUID()
	if err != nil {
		return "", err
	}
	if name == "" {
		name = "unnamed device"
	}
	_, err = s.DB.Exec(`INSERT INTO devices(id, name, client_name, token_hash, created_at) VALUES(?,?,?,?,?)`,
		id, name, clientName, tokenHash, Now())
	return id, err
}

// TouchDevice resolves a token hash to its device and updates last_seen.
func (s *Store) TouchDevice(tokenHash string, now int64) *DeviceRow {
	row := s.DB.QueryRow(`SELECT d.id, d.name, d.client_name, d.created_at FROM devices d
		WHERE d.token_hash=?`, tokenHash)
	var d DeviceRow
	if err := row.Scan(&d.ID, &d.Name, &d.ClientName, &d.CreatedAt); err != nil {
		return nil
	}
	_, _ = s.DB.Exec(`UPDATE devices SET last_seen=? WHERE id=?`, now, d.ID)
	d.LastSeen = now
	return &d
}

// ListDevices returns all devices with usage info.
func (s *Store) ListDevices() ([]DeviceRow, error) {
	rows, err := s.DB.Query(`SELECT id, name, client_name, created_at, last_seen FROM devices ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceRow
	for rows.Next() {
		var d DeviceRow
		if err := rows.Scan(&d.ID, &d.Name, &d.ClientName, &d.CreatedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeleteDevice revokes a device. ErrNotFound when the id does not exist so
// the revoke endpoint can answer 404 instead of a silent 200.
func (s *Store) DeleteDevice(id string) error {
	res, err := s.DB.Exec(`DELETE FROM devices WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- pairing codes ----

// SavePairCode stores a pairing code with expiry (single-active at a time).
// deviceName is optional: when set, the pair exchange names the device with
// it regardless of what the client sends (admin pre-decides the name).
func (s *Store) SavePairCode(code string, expiresAt int64, deviceName string) error {
	v := encodePairCode(code, expiresAt)
	if deviceName != "" {
		v += ":" + deviceName
	}
	_, err := s.DB.Exec(`INSERT INTO settings(key, value) VALUES('pair_code', ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, v)
	return err
}

// PairCodeDevice returns the device name bound to the stored code ("" if none).
func (s *Store) PairCodeDevice() string {
	v, err := s.SettingsGet("pair_code")
	if err != nil || v == "" {
		return ""
	}
	// format: code:expiry[:name] — name is everything after the second colon
	parts := strings.SplitN(v, ":", 3)
	if len(parts) == 3 {
		return parts[2]
	}
	return ""
}

// ConsumePairCode validates and removes a matching unexpired code.
// Returns the bound device name ("" when the code carries none) — the
// caller needs it AFTER consumption, and the stored value is wiped here.
func (s *Store) ConsumePairCode(code string) (string, bool) {
	v, err := s.SettingsGet("pair_code")
	if err != nil || v == "" {
		return "", false
	}
	gotCode, exp := decodePairCode(v)
	if gotCode != code || Now() > exp {
		return "", false
	}
	_ = s.SettingsSet("pair_code", "")
	parts := strings.SplitN(v, ":", 3)
	bound := ""
	if len(parts) == 3 {
		bound = parts[2]
	}
	return bound, true
}

func encodePairCode(code string, exp int64) string {
	return code + ":" + i64s(exp)
}

// decodePairCode parses "code:expiry[:deviceName]". The name is an opaque
// suffix after the SECOND colon — splitting at the LAST colon broke expiry
// parsing whenever the name contained non-digits (every Chinese name did),
// making every bound code look expired instantly.
func decodePairCode(v string) (string, int64) {
	first := strings.Index(v, ":")
	if first < 0 {
		return v, 0
	}
	rest := v[first+1:]
	second := strings.Index(rest, ":")
	if second < 0 {
		return v[:first], s2i(rest)
	}
	return v[:first], s2i(rest[:second])
}

func i64s(v int64) string {
	if v == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func s2i(s string) int64 {
	var n int64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int64(s[i]-'0')
	}
	return n
}

var _ = sql.ErrNoRows
