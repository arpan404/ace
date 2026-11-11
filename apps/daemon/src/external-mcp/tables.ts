/**
 * Outside MCP clients' grants (ADR 0117), their tokens as SHA-256 hashes, and the threads each
 * grant started or messaged. A revoked grant keeps its row so history can still name it. No rows
 * exist before this step: enrollments used to live in memory only.
 */
export const outsideGrantTables = `
  CREATE TABLE IF NOT EXISTS outside_grants (
    id TEXT PRIMARY KEY,
    client_kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    scopes TEXT NOT NULL,
    projects TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    approved_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outside_grant_tokens (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER,
    rotated_at INTEGER,
    pair TEXT,
    successor TEXT
  );
  CREATE INDEX IF NOT EXISTS outside_grant_tokens_grant ON outside_grant_tokens(grant_id);
  CREATE INDEX IF NOT EXISTS outside_grant_tokens_pair ON outside_grant_tokens(pair);
  CREATE TABLE IF NOT EXISTS outside_grant_threads (
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (grant_id, thread_id, kind)
  );`;
