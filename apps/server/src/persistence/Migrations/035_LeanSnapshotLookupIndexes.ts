import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_role_created_message
    ON projection_thread_messages(thread_id, role, created_at, message_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence_created_activity
    ON projection_thread_activities(thread_id, sequence, created_at, activity_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_updated_plan
    ON projection_thread_proposed_plans(thread_id, updated_at, plan_id)
  `;
});
