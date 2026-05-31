import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "fork_source_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_thread_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "fork_created_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_created_at TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      fork_source_thread_id = handoff_source_thread_id,
      fork_created_at = handoff_created_at,
      handoff_source_thread_id = NULL,
      handoff_from_provider = NULL,
      handoff_to_provider = NULL,
      handoff_mode = NULL,
      handoff_created_at = NULL
    WHERE handoff_mode = 'fork'
      AND fork_source_thread_id IS NULL
      AND handoff_source_thread_id IS NOT NULL
      AND handoff_created_at IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_fork_source_thread
    ON projection_threads(fork_source_thread_id)
  `;
});
