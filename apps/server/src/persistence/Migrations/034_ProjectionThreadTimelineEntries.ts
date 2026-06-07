import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_timeline_entries (
      thread_id TEXT NOT NULL,
      timeline_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      turn_id TEXT,
      sequence INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, timeline_index),
      UNIQUE (thread_id, kind, source_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_timeline_entries_thread_index
    ON projection_thread_timeline_entries(thread_id, timeline_index)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_timeline_entries_thread_source
    ON projection_thread_timeline_entries(thread_id, kind, source_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_timeline_entries_thread_updated
    ON projection_thread_timeline_entries(thread_id, updated_at)
  `;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_timeline_entries (
      thread_id,
      timeline_index,
      kind,
      source_id,
      turn_id,
      sequence,
      created_at,
      updated_at
    )
    WITH source_entries AS (
      SELECT
        thread_id,
        'message' AS kind,
        message_id AS source_id,
        turn_id,
        sequence,
        created_at,
        updated_at,
        CASE
          WHEN role = 'user' THEN 0
          WHEN role = 'assistant' THEN 2
          ELSE 1
        END AS sort_priority
      FROM projection_thread_messages
      UNION ALL
      SELECT
        thread_id,
        'activity' AS kind,
        activity_id AS source_id,
        turn_id,
        sequence,
        created_at,
        created_at AS updated_at,
        1 AS sort_priority
      FROM projection_thread_activities
      UNION ALL
      SELECT
        thread_id,
        'proposed-plan' AS kind,
        plan_id AS source_id,
        turn_id,
        NULL AS sequence,
        created_at,
        updated_at,
        1 AS sort_priority
      FROM projection_thread_proposed_plans
    ),
    indexed_entries AS (
      SELECT
        thread_id,
        kind,
        source_id,
        turn_id,
        sequence,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY
            created_at ASC,
              CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
              sequence ASC,
            sort_priority ASC,
            source_id ASC
        ) - 1 AS timeline_index
      FROM source_entries
    )
    SELECT
      thread_id,
      timeline_index,
      kind,
      source_id,
      turn_id,
      sequence,
      created_at,
      updated_at
    FROM indexed_entries
  `;
});
