CREATE TABLE daily_action_values_with_history_key (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES daily_actions(id) ON DELETE CASCADE,
  value_id TEXT REFERENCES app_values(id) ON DELETE SET NULL,
  value_key TEXT NOT NULL,
  value_name TEXT NOT NULL CHECK (length(trim(value_name)) BETWEEN 1 AND 80),
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1))
);

INSERT INTO daily_action_values_with_history_key
  (id, action_id, value_id, value_key, value_name, is_primary)
SELECT id, action_id, value_id,
  CASE
    WHEN value_id IS NULL THEN 'legacy:' || value_name
    ELSE 'value:' || value_id
  END,
  value_name, is_primary
FROM daily_action_values;

DROP TABLE daily_action_values;
ALTER TABLE daily_action_values_with_history_key RENAME TO daily_action_values;

CREATE UNIQUE INDEX daily_action_values_action_value
  ON daily_action_values (action_id, value_id);
CREATE UNIQUE INDEX daily_action_values_one_primary
  ON daily_action_values (action_id) WHERE is_primary = 1;
CREATE INDEX daily_action_values_value ON daily_action_values (value_id);
