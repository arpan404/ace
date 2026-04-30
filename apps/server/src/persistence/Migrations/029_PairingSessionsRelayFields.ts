import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const ignoreAlterFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch(() => Effect.void));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ignoreAlterFailure(
    sql`ALTER TABLE pairing_sessions ADD COLUMN relay_url TEXT NOT NULL DEFAULT ''`,
  );
  yield* ignoreAlterFailure(
    sql`ALTER TABLE pairing_sessions ADD COLUMN host_device_id TEXT NOT NULL DEFAULT ''`,
  );
  yield* ignoreAlterFailure(
    sql`ALTER TABLE pairing_sessions ADD COLUMN host_identity_public_key TEXT NOT NULL DEFAULT ''`,
  );
  yield* ignoreAlterFailure(sql`ALTER TABLE pairing_sessions ADD COLUMN viewer_device_id TEXT`);
  yield* ignoreAlterFailure(
    sql`ALTER TABLE pairing_sessions ADD COLUMN viewer_identity_public_key TEXT`,
  );
});
