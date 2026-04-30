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
  relayUrl: Schema.String,
  hostDeviceId: Schema.String,
  hostIdentityPublicKey: Schema.String,
  name: Schema.String,
  createdAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  claimId: Schema.NullOr(Schema.String),
  claimRequesterName: Schema.NullOr(Schema.String),
  claimRequestedAtMs: Schema.NullOr(Schema.Number),
  resolution: Schema.NullOr(Schema.String),
  resolvedAtMs: Schema.NullOr(Schema.Number),
  viewerDeviceId: Schema.NullOr(Schema.String),
  viewerIdentityPublicKey: Schema.NullOr(Schema.String),
});

export type PairingSessionRecord = typeof PairingSessionRecord.Type;

export interface PairingSessionRepositoryShape {
  readonly upsert: (
    session: PairingSessionRecord,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getAll: () => Effect.Effect<
    ReadonlyArray<PairingSessionRecord>,
    ProjectionRepositoryError
  >;

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
