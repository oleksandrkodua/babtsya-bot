-- Apply once before deploying the pending-queue Worker. Existing rows remain pending:
-- the old timestamp cursor cannot distinguish told context from late, untold arrivals.
ALTER TABLE messages ADD COLUMN processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1));
CREATE INDEX messages_pending ON messages (processed, ts);
CREATE TABLE digest_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires INTEGER NOT NULL
);
-- Keep webhook redelivery from resurrecting these rows after their first pending-queue digest.
INSERT OR IGNORE INTO ticks (key, ts)
SELECT 'ingest|' || message_id, CAST(strftime('%s', 'now') AS INTEGER) FROM messages;
