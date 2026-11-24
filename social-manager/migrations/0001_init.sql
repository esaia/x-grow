-- Instagram tables are prefixed ig_ so other networks can share the database.
-- Times are ISO-8601 UTC strings, so they sort and compare as text.

-- Connected accounts. Written by /connect/instagram, read by every webhook.
CREATE TABLE ig_accounts (
  id           TEXT PRIMARY KEY,  -- Instagram professional account id (= webhook entry.id)
  username     TEXT NOT NULL,
  token        TEXT NOT NULL,     -- system-user token; never leaves the Worker
  connected_at TEXT NOT NULL
);

-- Auto-reply rules. media_id set → a Reel rule (comments + DMs);
-- media_id NULL → a DM-only keyword.
CREATE TABLE ig_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     TEXT NOT NULL,
  media_id       TEXT UNIQUE,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL,              -- JSON array of strings
  link           TEXT NOT NULL,
  dm             TEXT NOT NULL,              -- {link} is replaced with link
  public_replies TEXT NOT NULL DEFAULT '[]', -- JSON array; one is picked at random
  any_comment    INTEGER NOT NULL DEFAULT 0, -- 1 → every comment gets the DM
  enabled        INTEGER NOT NULL DEFAULT 1,
  permalink      TEXT,                       -- snapshot of the Reel, for display
  caption        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX ig_rules_account ON ig_rules (account_id, created_at);

-- One DM + one public reply per person per Reel. The primary key makes the
-- claim atomic: of two simultaneous comments, exactly one inserts the row.
CREATE TABLE ig_sent (
  media_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (media_id, user_id)
);
CREATE INDEX ig_sent_at ON ig_sent (at);

-- Message ids already answered, so a redelivered DM webhook is a no-op.
CREATE TABLE ig_dm_seen (
  mid TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);
CREATE INDEX ig_dm_seen_at ON ig_dm_seen (at);

-- What the Worker did, for the admin panel's activity list and per-Reel counts.
CREATE TABLE ig_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- comment_dm | public_reply | dm
  ok         INTEGER NOT NULL,
  rule_id    INTEGER,
  media_id   TEXT,
  username   TEXT,            -- the commenter, when Instagram says
  text       TEXT,            -- their comment / message, trimmed
  keyword    TEXT,
  error      TEXT
);
CREATE INDEX ig_events_account_at ON ig_events (account_id, at);
CREATE INDEX ig_events_rule ON ig_events (rule_id, kind, ok);
