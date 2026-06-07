import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ProjectionThreadTimelineEntries", (it) => {
  it.effect("creates and backfills contiguous mixed timeline entries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          sequence,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user',
            'thread-migration',
            'turn-migration',
            'user',
            'Run checks',
            0,
            1,
            '2026-04-01T00:00:01.000Z',
            '2026-04-01T00:00:01.000Z'
          ),
          (
            'message-assistant',
            'thread-migration',
            'turn-migration',
            'assistant',
            'Done',
            0,
            4,
            '2026-04-01T00:00:04.000Z',
            '2026-04-01T00:00:04.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-tool',
          'thread-migration',
          'turn-migration',
          'tool',
          'tool.completed',
          'Run command',
          '{}',
          2,
          '2026-04-01T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-migration',
          'thread-migration',
          'turn-migration',
          'Plan',
          NULL,
          NULL,
          '2026-04-01T00:00:03.000Z',
          '2026-04-01T00:00:03.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const indexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(projection_thread_timeline_entries)
      `;
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_timeline_entries_thread_index",
        ),
      );

      const rows = yield* sql<{
        readonly timelineIndex: number;
        readonly kind: string;
        readonly sourceId: string;
      }>`
        SELECT
          timeline_index AS "timelineIndex",
          kind,
          source_id AS "sourceId"
        FROM projection_thread_timeline_entries
        WHERE thread_id = 'thread-migration'
        ORDER BY timeline_index ASC
      `;

      assert.deepStrictEqual(rows, [
        { timelineIndex: 0, kind: "message", sourceId: "message-user" },
        { timelineIndex: 1, kind: "activity", sourceId: "activity-tool" },
        { timelineIndex: 2, kind: "proposed-plan", sourceId: "plan-migration" },
        { timelineIndex: 3, kind: "message", sourceId: "message-assistant" },
      ]);
    }),
  );
});
