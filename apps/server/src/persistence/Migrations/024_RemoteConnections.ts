import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_connections (
      connection_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ws_url TEXT NOT NULL UNIQUE,
      auth_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_connected_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_remote_connections_updated_at
    ON remote_connections(updated_at DESC, connection_id ASC)
  `;
});
