import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_DropProjectionThreadTimelineEntries", (it) => {
  it.effect("drops timeline-entry persistence table and indexes from the live schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const objects = yield* sql<{
        readonly name: string;
        readonly type: string;
      }>`
        SELECT name, type
        FROM sqlite_master
        WHERE name IN (
          'projection_thread_timeline_entries',
          'idx_projection_thread_timeline_entries_thread_index',
          'idx_projection_thread_timeline_entries_thread_source',
          'idx_projection_thread_timeline_entries_thread_updated'
        )
        ORDER BY name ASC
      `;

      assert.deepStrictEqual(objects, []);
    }),
  );
});
