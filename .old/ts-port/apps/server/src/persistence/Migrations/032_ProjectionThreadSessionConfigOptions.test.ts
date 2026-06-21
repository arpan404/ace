import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("032_ProjectionThreadSessionConfigOptions", (it) => {
  it.effect("adds config_options_json to projection_thread_sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 31 });
      yield* runMigrations({ toMigrationInclusive: 32 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        SELECT
          name,
          "notnull",
          dflt_value
        FROM pragma_table_info('projection_thread_sessions')
        WHERE name = 'config_options_json'
      `;

      assert.deepStrictEqual(columns, [
        {
          name: "config_options_json",
          notnull: 1,
          dflt_value: "'[]'",
        },
      ]);
    }),
  );
});
