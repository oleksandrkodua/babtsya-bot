-- Apply once before deploying the reminders (04.11.2026). due = unix seconds; target = the name as written (resolved against `people` when sent).
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  due INTEGER NOT NULL,
  target TEXT NOT NULL,
  what TEXT NOT NULL,
  author TEXT NOT NULL,
  message_id INTEGER,
  created INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (sent, due);
