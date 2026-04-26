import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'coding'
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET kind = 'coding'
    WHERE kind NOT IN ('coding', 'chat')
  `;
});
