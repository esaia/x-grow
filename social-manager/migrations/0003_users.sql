-- People who can log in to the admin panel. The ADMIN_KEY secret still logs
-- in as an owner (the way back in if every password is lost).
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,      -- email, lowercased
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  pw_hash       TEXT NOT NULL,             -- PBKDF2-SHA256, hex
  pw_salt       TEXT NOT NULL,             -- random per password; also versions sessions
  pw_iter       INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Which connected accounts a member may see and manage. Owners see all.
CREATE TABLE user_accounts (
  user_id    INTEGER NOT NULL,
  network    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (user_id, network, account_id)
);

-- Failed logins, for throttling. Trimmed by the daily cron.
CREATE TABLE login_failures (
  login TEXT NOT NULL,
  at    TEXT NOT NULL
);
CREATE INDEX login_failures_login_at ON login_failures (login, at);

-- Who changed a rule, and who pressed "send" on past comments.
ALTER TABLE rules ADD COLUMN updated_by TEXT;
ALTER TABLE events ADD COLUMN actor TEXT;
