import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_timeline_entries_thread_updated
  `;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_timeline_entries_thread_source
  `;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_timeline_entries_thread_index
  `;

  yield* sql`
    DROP TABLE IF EXISTS projection_thread_timeline_entries
  `;
});
