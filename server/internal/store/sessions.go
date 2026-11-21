package store

import (
	"database/sql"
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
	ID        string
	Name      string
	CreatedAt int64
	LastSeen  int64
}

// CreateDevice registers a device by token hash.
func (s *Store) CreateDevice(tokenHash, name string) (string, error) {
	id, err := NewUUID()
	if err != nil {
		return "", err
	}
	if name == "" {
		name = "unnamed device"
	}
	_, err = s.DB.Exec(`INSERT INTO devices(id, name, token_hash, created_at) VALUES(?,?,?,?)`,
		id, name, tokenHash, Now())
	return id, err
}

// TouchDevice resolves a token hash to its device and updates last_seen.
func (s *Store) TouchDevice(tokenHash string, now int64) *DeviceRow {
	row := s.DB.QueryRow(`SELECT d.id, d.name, d.created_at FROM devices d
		WHERE d.token_hash=?`, tokenHash)
	var d DeviceRow
	if err := row.Scan(&d.ID, &d.Name, &d.CreatedAt); err != nil {
		return nil
	}
	_, _ = s.DB.Exec(`UPDATE devices SET last_seen=? WHERE id=?`, now, d.ID)
	d.LastSeen = now
	return &d
}

// ListDevices returns all devices with usage info.
func (s *Store) ListDevices() ([]DeviceRow, error) {
	rows, err := s.DB.Query(`SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceRow
	for rows.Next() {
		var d DeviceRow
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// DeleteDevice revokes a device.
func (s *Store) DeleteDevice(id string) error {
	_, err := s.DB.Exec(`DELETE FROM devices WHERE id=?`, id)
	return err
}

// ---- pairing codes ----

// SavePairCode stores a pairing code with expiry (single-active at a time).
func (s *Store) SavePairCode(code string, expiresAt int64) error {
	_, err := s.DB.Exec(`INSERT INTO settings(key, value) VALUES('pair_code', ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, encodePairCode(code, expiresAt))
	return err
}

// ConsumePairCode validates and removes a matching unexpired code.
func (s *Store) ConsumePairCode(code string) bool {
	v, err := s.SettingsGet("pair_code")
	if err != nil || v == "" {
		return false
	}
	gotCode, exp := decodePairCode(v)
	if gotCode != code || Now() > exp {
		return false
	}
	_ = s.SettingsSet("pair_code", "")
	return true
}

func encodePairCode(code string, exp int64) string {
	return code + ":" + i64s(exp)
}

func decodePairCode(v string) (string, int64) {
	// split at last colon; code is digits only
	for i := len(v) - 1; i >= 0; i-- {
		if v[i] == ':' {
			return v[:i], s2i(v[i+1:])
		}
	}
	return v, 0
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
