-- Panel-wide settings, one JSON value per key. First key: rule_defaults, the
-- texts a new auto-reply starts with (Settings page).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
