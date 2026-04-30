import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  PairingSessionRecord,
  PairingSessionRepository,
  type PairingSessionRepositoryShape,
} from "../Services/PairingSessions.ts";

const makePairingSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertSessionRow = SqlSchema.void({
    Request: PairingSessionRecord,
    execute: (session) =>
      sql`
        INSERT INTO pairing_sessions (
          session_id,
          secret,
          ws_url,
          auth_token,
          relay_url,
          host_device_id,
          host_identity_public_key,
          name,
          created_at_ms,
          expires_at_ms,
          claim_id,
          claim_requester_name,
          claim_requested_at_ms,
          resolution,
          resolved_at_ms,
          viewer_device_id,
          viewer_identity_public_key
        )
        VALUES (
          ${session.sessionId},
          ${session.secret},
          ${session.wsUrl},
          ${session.authToken},
          ${session.relayUrl},
          ${session.hostDeviceId},
          ${session.hostIdentityPublicKey},
          ${session.name},
          ${session.createdAtMs},
          ${session.expiresAtMs},
          ${session.claimId},
          ${session.claimRequesterName},
          ${session.claimRequestedAtMs},
          ${session.resolution},
          ${session.resolvedAtMs},
          ${session.viewerDeviceId},
          ${session.viewerIdentityPublicKey}
        )
        ON CONFLICT (session_id)
        DO UPDATE SET
          relay_url = excluded.relay_url,
          host_device_id = excluded.host_device_id,
          host_identity_public_key = excluded.host_identity_public_key,
          claim_id = excluded.claim_id,
          claim_requester_name = excluded.claim_requester_name,
          claim_requested_at_ms = excluded.claim_requested_at_ms,
          resolution = excluded.resolution,
          resolved_at_ms = excluded.resolved_at_ms,
          viewer_device_id = excluded.viewer_device_id,
          viewer_identity_public_key = excluded.viewer_identity_public_key
      `,
  });

  const getSessionByIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String }),
    Result: PairingSessionRecord,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          secret,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          relay_url AS "relayUrl",
          host_device_id AS "hostDeviceId",
          host_identity_public_key AS "hostIdentityPublicKey",
          name,
          created_at_ms AS "createdAtMs",
          expires_at_ms AS "expiresAtMs",
          claim_id AS "claimId",
          claim_requester_name AS "claimRequesterName",
          claim_requested_at_ms AS "claimRequestedAtMs",
          resolution,
          resolved_at_ms AS "resolvedAtMs",
          viewer_device_id AS "viewerDeviceId",
          viewer_identity_public_key AS "viewerIdentityPublicKey"
        FROM pairing_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const getSessionByClaimIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ claimId: Schema.String }),
    Result: PairingSessionRecord,
    execute: ({ claimId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          secret,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          relay_url AS "relayUrl",
          host_device_id AS "hostDeviceId",
          host_identity_public_key AS "hostIdentityPublicKey",
          name,
          created_at_ms AS "createdAtMs",
          expires_at_ms AS "expiresAtMs",
          claim_id AS "claimId",
          claim_requester_name AS "claimRequesterName",
          claim_requested_at_ms AS "claimRequestedAtMs",
          resolution,
          resolved_at_ms AS "resolvedAtMs",
          viewer_device_id AS "viewerDeviceId",
          viewer_identity_public_key AS "viewerIdentityPublicKey"
        FROM pairing_sessions
        WHERE claim_id = ${claimId}
      `,
  });

  const getAllSessionsRow = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: PairingSessionRecord,
    execute: () =>
      sql`
        SELECT
          session_id AS "sessionId",
          secret,
          ws_url AS "wsUrl",
          auth_token AS "authToken",
          relay_url AS "relayUrl",
          host_device_id AS "hostDeviceId",
          host_identity_public_key AS "hostIdentityPublicKey",
          name,
          created_at_ms AS "createdAtMs",
          expires_at_ms AS "expiresAtMs",
          claim_id AS "claimId",
          claim_requester_name AS "claimRequesterName",
          claim_requested_at_ms AS "claimRequestedAtMs",
          resolution,
          resolved_at_ms AS "resolvedAtMs",
          viewer_device_id AS "viewerDeviceId",
          viewer_identity_public_key AS "viewerIdentityPublicKey"
        FROM pairing_sessions
      `,
  });

  const deleteSessionRow = SqlSchema.void({
    Request: Schema.Struct({ sessionId: Schema.String }),
    execute: ({ sessionId }) =>
      sql`
        DELETE FROM pairing_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const deleteExpiredSessionsRow = SqlSchema.findAll({
    Request: Schema.Struct({ nowMs: Schema.Number }),
    Result: Schema.Struct({ sessionId: Schema.String }),
    execute: ({ nowMs }) =>
      sql`
        DELETE FROM pairing_sessions
        WHERE expires_at_ms < ${nowMs}
        RETURNING session_id AS "sessionId"
      `,
  });

  const upsert: PairingSessionRepositoryShape["upsert"] = (session) =>
    upsertSessionRow(session).pipe(
      Effect.mapError(toPersistenceSqlError("PairingSessionRepository.upsert:query")),
    );

  const getBySessionId: PairingSessionRepositoryShape["getBySessionId"] = (sessionId) =>
    getSessionByIdRow({ sessionId }).pipe(
      Effect.mapError(toPersistenceSqlError("PairingSessionRepository.getBySessionId:query")),
    );

  const getAll: PairingSessionRepositoryShape["getAll"] = () =>
    getAllSessionsRow({}).pipe(
      Effect.mapError(toPersistenceSqlError("PairingSessionRepository.getAll:query")),
    );

  const getByClaimId: PairingSessionRepositoryShape["getByClaimId"] = (claimId) =>
    getSessionByClaimIdRow({ claimId }).pipe(
      Effect.mapError(toPersistenceSqlError("PairingSessionRepository.getByClaimId:query")),
    );

  const deleteBySessionId: PairingSessionRepositoryShape["deleteBySessionId"] = (sessionId) =>
    deleteSessionRow({ sessionId }).pipe(
      Effect.mapError(toPersistenceSqlError("PairingSessionRepository.deleteBySessionId:query")),
    );

  const deleteExpiredSessions: PairingSessionRepositoryShape["deleteExpiredSessions"] = (nowMs) =>
    deleteExpiredSessionsRow({ nowMs }).pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(
        toPersistenceSqlError("PairingSessionRepository.deleteExpiredSessions:query"),
      ),
    );

  return {
    upsert,
    getAll,
    getBySessionId,
    getByClaimId,
    deleteBySessionId,
    deleteExpiredSessions,
  } satisfies PairingSessionRepositoryShape;
});

export const PairingSessionRepositoryLive = Layer.effect(
  PairingSessionRepository,
  makePairingSessionRepository,
);
