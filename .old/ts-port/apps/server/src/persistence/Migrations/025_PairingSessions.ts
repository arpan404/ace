import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      session_id TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      ws_url TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      claim_id TEXT,
      claim_requester_name TEXT,
      claim_requested_at_ms INTEGER,
      resolution TEXT,
      resolved_at_ms INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_expires_at_ms
    ON pairing_sessions(expires_at_ms ASC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_claim_id
    ON pairing_sessions(claim_id)
    WHERE claim_id IS NOT NULL
  `;
});
