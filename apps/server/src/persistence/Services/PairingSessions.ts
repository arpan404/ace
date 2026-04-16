import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PairingClaimRecord = Schema.Struct({
  claimId: Schema.String,
  requesterName: Schema.String,
  requestedAtMs: Schema.Number,
});

export const PairingSessionRecord = Schema.Struct({
  sessionId: Schema.String,
  secret: Schema.String,
  wsUrl: Schema.String,
  authToken: Schema.String,
  name: Schema.String,
  createdAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  claimId: Schema.String,
  claimRequesterName: Schema.String,
  claimRequestedAtMs: Schema.Number,
  resolution: Schema.String,
  resolvedAtMs: Schema.Number,
});

export type PairingSessionRecord = typeof PairingSessionRecord.Type;

export interface PairingSessionRepositoryShape {
  readonly upsert: (
    session: PairingSessionRecord,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<PairingSessionRecord>, ProjectionRepositoryError>;

  readonly getByClaimId: (
    claimId: string,
  ) => Effect.Effect<Option.Option<PairingSessionRecord>, ProjectionRepositoryError>;

  readonly deleteBySessionId: (sessionId: string) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly deleteExpiredSessions: (
    nowMs: number,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class PairingSessionRepository extends ServiceMap.Service<
  PairingSessionRepository,
  PairingSessionRepositoryShape
>()("ace/persistence/Services/PairingSessions/PairingSessionRepository") {}
