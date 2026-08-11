// Package store is the embedded SQLite data layer (users, sessions, and later config/CA).
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (works with CGO_ENABLED=0)
)

var ErrNotFound = errors.New("not found")

type User struct {
	ID           int64
	Email        string
	Name         string
	Surname      string
	PasswordHash string
	Role         string // admin | helpdesk | viewer
	TOTPSecret   string // base32 TOTP secret ("" when MFA not set up)
	TOTPEnabled  bool   // true once the user has confirmed a code
	CreatedAt    time.Time
}

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite is single-writer; one connection + WAL keeps things simple and lock-free here.
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			return nil, fmt.Errorf("pragma %q: %w", pragma, err)
		}
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  surname       TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One-time recovery codes for MFA; stored hashed (never in the clear).
CREATE TABLE IF NOT EXISTS recovery_codes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

-- Short-lived pre-auth challenges issued after a correct password when MFA is on.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`); err != nil {
		return err
	}

	// Additive column migrations for databases created before MFA existed.
	if err := s.ensureColumn("users", "totp_secret TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn("users", "totp_enabled INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return nil
}

// ensureColumn adds a column, treating "already exists" as success so migrate() is idempotent.
func (s *Store) ensureColumn(table, ddl string) error {
	_, err := s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s", table, ddl))
	if err != nil && strings.Contains(err.Error(), "duplicate column name") {
		return nil
	}
	return err
}

// --- users ---

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) CreateUser(ctx context.Context, u User) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users(email,name,surname,password_hash,role,created_at) VALUES(?,?,?,?,?,?)`,
		u.Email, u.Name, u.Surname, u.PasswordHash, u.Role, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

const userColumns = `id,email,name,surname,password_hash,role,totp_secret,totp_enabled,created_at`

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE email=?`, email))
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE id=?`, id))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanUserRow(row rowScanner) (*User, error) {
	var u User
	var created int64
	var totpEnabled int
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.Surname, &u.PasswordHash, &u.Role, &u.TOTPSecret, &totpEnabled, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.TOTPEnabled = totpEnabled != 0
	u.CreatedAt = time.Unix(created, 0)
	return &u, nil
}

func (s *Store) scanUser(row *sql.Row) (*User, error) { return scanUserRow(row) }

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+userColumns+` FROM users ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUserRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) UpdateUserProfile(ctx context.Context, id int64, name, surname, role string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET name=?,surname=?,role=? WHERE id=?`, name, surname, role, id)
	return err
}

func (s *Store) UpdatePassword(ctx context.Context, id int64, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash=? WHERE id=?`, hash, id)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id=?`, id)
	return err
}

func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role='admin'`).Scan(&n)
	return n, err
}

// --- MFA (TOTP + recovery codes + login challenges) ---

// SetTOTPSecret stores a pending secret (enrollment); MFA stays disabled until confirmed.
func (s *Store) SetTOTPSecret(ctx context.Context, id int64, secret string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?`, secret, id)
	return err
}

// EnableTOTP flips MFA on after the user confirms a valid code.
func (s *Store) EnableTOTP(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET totp_enabled=1 WHERE id=?`, id)
	return err
}

// DisableTOTP clears the secret, disables MFA, and discards any recovery codes.
func (s *Store) DisableTOTP(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET totp_secret='', totp_enabled=0 WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_codes WHERE user_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplaceRecoveryCodes swaps the user's recovery codes for a fresh set of hashes.
func (s *Store) ReplaceRecoveryCodes(ctx context.Context, userID int64, hashes []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_codes WHERE user_id=?`, userID); err != nil {
		return err
	}
	for _, h := range hashes {
		if _, err := tx.ExecContext(ctx, `INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)`, userID, h); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ConsumeRecoveryCode marks a matching unused code used and reports whether one was found.
func (s *Store) ConsumeRecoveryCode(ctx context.Context, userID int64, hash string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL`,
		time.Now().Unix(), userID, hash)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// CountUnusedRecoveryCodes reports how many recovery codes remain for a user.
func (s *Store) CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM recovery_codes WHERE user_id=? AND used_at IS NULL`, userID).Scan(&n)
	return n, err
}

func (s *Store) CreateMFAChallenge(ctx context.Context, id string, userID int64, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO mfa_challenges(id,user_id,created_at,expires_at) VALUES(?,?,?,?)`,
		id, userID, time.Now().Unix(), expires.Unix())
	return err
}

// MFAChallengeUserID returns the user for a valid, unexpired challenge, deleting it if expired.
func (s *Store) MFAChallengeUserID(ctx context.Context, id string) (int64, error) {
	var userID, expires int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id,expires_at FROM mfa_challenges WHERE id=?`, id).Scan(&userID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if time.Now().Unix() > expires {
		_ = s.DeleteMFAChallenge(ctx, id)
		return 0, ErrNotFound
	}
	return userID, nil
}

func (s *Store) DeleteMFAChallenge(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM mfa_challenges WHERE id=?`, id)
	return err
}

// --- sessions ---

func (s *Store) CreateSession(ctx context.Context, id string, userID int64, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)`,
		id, userID, time.Now().Unix(), expires.Unix())
	return err
}

// SessionUser returns the user for a valid, unexpired session id, deleting it if expired.
func (s *Store) SessionUser(ctx context.Context, id string) (*User, error) {
	var userID, expires int64
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id,expires_at FROM sessions WHERE id=?`, id).Scan(&userID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if time.Now().Unix() > expires {
		_ = s.DeleteSession(ctx, id)
		return nil, ErrNotFound
	}
	return s.UserByID(ctx, userID)
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id=?`, id)
	return err
}
