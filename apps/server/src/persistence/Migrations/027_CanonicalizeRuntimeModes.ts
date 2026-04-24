import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_RUNTIME_MODE = "full-access";
const VALID_RUNTIME_MODES = ["approval-required", "full-access"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET runtime_mode = ${DEFAULT_RUNTIME_MODE}
    WHERE runtime_mode NOT IN ${sql.in(VALID_RUNTIME_MODES)}
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET runtime_mode = ${DEFAULT_RUNTIME_MODE}
    WHERE runtime_mode NOT IN ${sql.in(VALID_RUNTIME_MODES)}
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_mode = ${DEFAULT_RUNTIME_MODE}
    WHERE runtime_mode NOT IN ${sql.in(VALID_RUNTIME_MODES)}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.runtimeMode', ${DEFAULT_RUNTIME_MODE})
    WHERE event_type IN ('thread.created', 'thread.runtime-mode-set', 'thread.turn-start-requested')
      AND json_type(payload_json, '$.runtimeMode') IS NOT NULL
      AND json_extract(payload_json, '$.runtimeMode') NOT IN ${sql.in(VALID_RUNTIME_MODES)}
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.session.runtimeMode', ${DEFAULT_RUNTIME_MODE})
    WHERE event_type = 'thread.session-set'
      AND json_type(payload_json, '$.session.runtimeMode') IS NOT NULL
      AND json_extract(payload_json, '$.session.runtimeMode') NOT IN ${sql.in(VALID_RUNTIME_MODES)}
  `;
});
