-- Apply once after 0001, before deploying. The D1 file import and the local test are atomic.
CREATE TABLE polls_next (
  day TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  zrada INTEGER,
  peremoga INTEGER,
  close_error TEXT,
  PRIMARY KEY (chat_id, message_id)
);
INSERT INTO polls_next (day, chat_id, message_id, zrada, peremoga)
SELECT day, chat_id, message_id, zrada, peremoga FROM polls ORDER BY rowid;
DROP TABLE polls;
ALTER TABLE polls_next RENAME TO polls;
