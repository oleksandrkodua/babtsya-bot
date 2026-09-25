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

-- One row per daily poll: sent at 21:00, closed at 22:00 before the evening play; counts feed the day and week verdicts.
CREATE TABLE IF NOT EXISTS polls (
  day TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  zrada INTEGER,
  peremoga INTEGER
);

-- Stock of pictures made ahead and scored by the committee (meat for the Deli tease). data = the JPEG as base64,
-- kept here until it's sent, then cleared (25.09.2026: no parking in the owner's private chat). Rows from the first
-- day have a Telegram file_id instead and no data. Existing base: ALTER TABLE pics ADD COLUMN data TEXT (once).
CREATE TABLE IF NOT EXISTS pics (
  file_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  score REAL NOT NULL,
  created INTEGER NOT NULL,
  used INTEGER,
  data TEXT
);

-- Name → Telegram user id, refreshed from every message: a real tag (text_mention) needs the id. Kept across digests.
CREATE TABLE IF NOT EXISTS people (
  name TEXT PRIMARY KEY,
  uid INTEGER NOT NULL
);
