-- Subscriptions' terms changes between builds (ADR 0205 §4): the signed notices, newest
-- `issued` only, served at `/v1/notices`.
CREATE TABLE notices (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);
