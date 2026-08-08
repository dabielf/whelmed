PRAGMA foreign_keys = ON;

CREATE TABLE app_values (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  meaning TEXT CHECK (meaning IS NULL OR length(meaning) <= 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX app_values_name ON app_values (name COLLATE NOCASE);
CREATE INDEX app_values_status_position ON app_values (status, position);

CREATE TABLE action_menu_entries (
  id TEXT PRIMARY KEY,
  value_id TEXT NOT NULL REFERENCES app_values(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX action_menu_entries_value_position
  ON action_menu_entries (value_id, position);

CREATE TABLE daily_actions (
  id TEXT PRIMARY KEY,
  action_date TEXT NOT NULL CHECK (action_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('planned', 'done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX daily_actions_date_status ON daily_actions (action_date, status);

CREATE TABLE daily_action_values (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES daily_actions(id) ON DELETE CASCADE,
  value_id TEXT REFERENCES app_values(id) ON DELETE SET NULL,
  value_name TEXT NOT NULL CHECK (length(trim(value_name)) BETWEEN 1 AND 80),
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1))
);

CREATE UNIQUE INDEX daily_action_values_action_value
  ON daily_action_values (action_id, value_id);
CREATE UNIQUE INDEX daily_action_values_one_primary
  ON daily_action_values (action_id) WHERE is_primary = 1;
CREATE INDEX daily_action_values_value ON daily_action_values (value_id);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 200),
  horizon TEXT NOT NULL CHECK (horizon IN ('week', 'month', 'year', 'someday')),
  period_start TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'needs_review')),
  position INTEGER NOT NULL CHECK (position >= 0),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (horizon = 'someday' AND period_start IS NULL)
    OR (horizon != 'someday' AND period_start IS NOT NULL)
  )
);

CREATE INDEX goals_state_period_position
  ON goals (status, horizon, period_start, position);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_time_zone TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO settings (id, app_time_zone, updated_at)
VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
