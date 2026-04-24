import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("027_CanonicalizeRuntimeModes", (it) => {
  it.effect("normalizes invalid persisted runtime modes before snapshot decode", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 26 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode,
          archived_at,
          queued_composer_messages_json,
          queued_steer_request_json,
          handoff_source_thread_id,
          handoff_from_provider,
          handoff_to_provider,
          handoff_mode,
          handoff_created_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread',
          '{"provider":"codex","model":"gpt-5.4"}',
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'andy',
          'default',
          NULL,
          '[]',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          'andy'
        )
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          'thread-1',
          'codex',
          'codex',
          'andy',
          'active',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
        (
          'event-thread-created',
          'thread',
          'thread-1',
          1,
          'thread.created',
          '2026-01-01T00:00:00.000Z',
          'command-thread-created',
          NULL,
          'correlation-thread-created',
          'user',
          '{"threadId":"thread-1","projectId":"project-1","title":"Thread","modelSelection":{"provider":"codex","model":"gpt-5.4"},"runtimeMode":"andy","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-session-set',
          'thread',
          'thread-1',
          2,
          'thread.session-set',
          '2026-01-01T00:00:01.000Z',
          'command-session-set',
          NULL,
          'correlation-session-set',
          'server',
          '{"threadId":"thread-1","session":{"status":"running","provider":"codex","providerSessionId":"provider-session-1","providerThreadId":"provider-thread-1","activeTurnId":null,"runtimeMode":"andy","lastError":null,"updatedAt":"2026-01-01T00:00:00.000Z"}}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 27 });

      const projectionThreadRows = yield* sql<{ readonly runtimeMode: string }>`
        SELECT runtime_mode AS "runtimeMode" FROM projection_threads
      `;
      assert.deepStrictEqual(projectionThreadRows, [{ runtimeMode: "full-access" }]);

      const sessionRows = yield* sql<{ readonly runtimeMode: string }>`
        SELECT runtime_mode AS "runtimeMode" FROM projection_thread_sessions
      `;
      assert.deepStrictEqual(sessionRows, [{ runtimeMode: "full-access" }]);

      const providerRuntimeRows = yield* sql<{ readonly runtimeMode: string }>`
        SELECT runtime_mode AS "runtimeMode" FROM provider_session_runtime
      `;
      assert.deepStrictEqual(providerRuntimeRows, [{ runtimeMode: "full-access" }]);

      const eventRows = yield* sql<{
        readonly eventType: string;
        readonly runtimeMode: string;
      }>`
        SELECT
          event_type AS "eventType",
          CASE
            WHEN event_type = 'thread.session-set'
              THEN json_extract(payload_json, '$.session.runtimeMode')
            ELSE json_extract(payload_json, '$.runtimeMode')
          END AS "runtimeMode"
        FROM orchestration_events
        ORDER BY stream_version
      `;
      assert.deepStrictEqual(eventRows, [
        { eventType: "thread.created", runtimeMode: "full-access" },
        { eventType: "thread.session-set", runtimeMode: "full-access" },
      ]);
    }),
  );
});
