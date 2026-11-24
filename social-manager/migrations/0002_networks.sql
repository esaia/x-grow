-- Generalise the Instagram tables so Facebook Pages (and later networks)
-- share them. Every existing row is kept and marked network = 'instagram'.

-- Accounts: an Instagram account or a Facebook Page. The primary key now
-- includes the network, since ids are only unique within one network.
CREATE TABLE accounts (
  network      TEXT NOT NULL,    -- 'instagram' | 'facebook'
  id           TEXT NOT NULL,    -- Instagram account id / Facebook Page id (= webhook entry.id)
  username     TEXT NOT NULL,    -- Instagram @handle / Facebook Page name
  token        TEXT NOT NULL,    -- never leaves the Worker
  connected_at TEXT NOT NULL,
  PRIMARY KEY (network, id)
);
INSERT INTO accounts (network, id, username, token, connected_at)
  SELECT 'instagram', id, username, token, connected_at FROM ig_accounts;
DROP TABLE ig_accounts;

-- Auto-reply rules. media_id: the Reel / post it answers comments on;
-- NULL → a DM-only keyword. Ids are kept, so links and history still match.
CREATE TABLE rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  network        TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  media_id       TEXT,
  name           TEXT NOT NULL,
  keywords       TEXT NOT NULL,
  link           TEXT NOT NULL,
  dm             TEXT NOT NULL,
  public_replies TEXT NOT NULL DEFAULT '[]',
  any_comment    INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  permalink      TEXT,
  caption        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (network, media_id)
);
INSERT INTO rules (id, network, account_id, media_id, name, keywords, link, dm, public_replies,
                   any_comment, enabled, permalink, caption, created_at, updated_at)
  SELECT id, 'instagram', account_id, media_id, name, keywords, link, dm, public_replies,
         any_comment, enabled, permalink, caption, created_at, updated_at FROM ig_rules;
DROP TABLE ig_rules;
CREATE INDEX rules_account ON rules (network, account_id, created_at);

-- Dedup tables: media / comment / message ids are already unique across
-- networks, so they only need a neutral name.
ALTER TABLE ig_sent RENAME TO sent;
ALTER TABLE ig_dm_seen RENAME TO dm_seen;

-- Activity log.
ALTER TABLE ig_events RENAME TO events;
ALTER TABLE events ADD COLUMN network TEXT NOT NULL DEFAULT 'instagram';
CREATE INDEX events_network_account_at ON events (network, account_id, at);
