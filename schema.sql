-- Messages waiting for the next digest; deleted once a digest that includes them is published.
CREATE TABLE IF NOT EXISTS messages (
  message_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  tag TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);

-- One row per published digest: stops double posting and keeps the plan as context for the next one.
CREATE TABLE IF NOT EXISTS digests (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

-- Name → Telegram user id, refreshed from every message: a real tag (text_mention) needs the id. Kept across digests.
CREATE TABLE IF NOT EXISTS people (
  name TEXT PRIMARY KEY,
  uid INTEGER NOT NULL
);
