import * as Crypto from "node:crypto";
import { deriveRelayPairingAuthKey, verifyRelayRouteAuthProof } from "@ace/shared/relay";
import { Effect } from "effect";
import type { ProjectionRepositoryError } from "./persistence/Errors";

const DEFAULT_PAIRING_SESSION_TTL_MS = 5 * 60_000;
const MIN_PAIRING_SESSION_TTL_MS = 30_000;
const MAX_PAIRING_SESSION_TTL_MS = 15 * 60 * 1000;
const PAIRING_SESSION_EXPIRED_GRACE_MS = 10 * 60 * 1000;
const MAX_HOST_NAME_LENGTH = 160;
const MAX_REQUESTER_NAME_LENGTH = 120;

export type PairingSessionStatus =
  | "waiting-claim"
  | "claim-pending"
  | "approved"
  | "rejected"
  | "expired";

export type PairingClaimStatus = "pending" | "approved" | "rejected" | "expired";

export type PairingErrorCode =
  | "not-found"
  | "expired"
  | "invalid-secret"
  | "already-claimed"
  | "invalid-ws-url"
  | "claim-missing";

export interface PairingFailure {
  readonly ok: false;
  readonly code: PairingErrorCode;
  readonly message: string;
}

export interface PairingSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export type PairingResult<TValue> = PairingSuccess<TValue> | PairingFailure;

interface PairingClaimRecord {
  readonly claimId: string;
  readonly requesterName: string;
  readonly requestedAtMs: number;
}

interface PairingSessionRecord {
  readonly sessionId: string;
  secret: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly relayUrl: string;
  readonly hostDeviceId: string;
  readonly hostIdentityPublicKey: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  relayAuthKey: string | null;
  claim: PairingClaimRecord | null;
  resolution: "approved" | "rejected" | null;
  resolvedAtMs: number | null;
  viewerDeviceId: string | null;
  viewerIdentityPublicKey: string | null;
}

const pairingSessions = new Map<string, PairingSessionRecord>();
const pairingClaimSessions = new Map<string, string>();

export interface CreatePairingSessionInput {
  readonly wsUrl?: string;
  readonly authToken?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
  readonly name?: string;
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

export interface PairingSessionCreated {
  readonly sessionId: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly status: PairingSessionStatus;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
}

export interface PairingSessionView {
  readonly sessionId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
  readonly status: PairingSessionStatus;
  readonly expiresAt: string;
  readonly requesterName?: string | undefined;
  readonly claimId?: string | undefined;
  readonly relayUrl?: string | undefined;
  readonly hostDeviceId?: string | undefined;
  readonly viewerDeviceId?: string | undefined;
}

export interface ClaimPairingSessionInput {
  readonly sessionId: string;
  readonly secret: string;
  readonly requesterName?: string;
  readonly nowMs?: number;
}

export interface PairingClaimCreated {
  readonly claimId: string;
  readonly status: PairingClaimStatus;
  readonly expiresAt: string;
}

export interface PairingClaimApprovedHost {
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
}

export type PairingClaimView =
  | {
      readonly claimId: string;
      readonly status: "pending";
      readonly expiresAt: string;
    }
  | {
      readonly claimId: string;
      readonly status: "approved";
      readonly host: PairingClaimApprovedHost;
    }
  | {
      readonly claimId: string;
      readonly status: "rejected" | "expired";
    };

function succeed<TValue>(value: TValue): PairingSuccess<TValue> {
  return { ok: true, value };
}

function fail(code: PairingErrorCode, message: string): PairingFailure {
  return { ok: false, code, message };
}

function clampTtlMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PAIRING_SESSION_TTL_MS;
  }
  return Math.round(
    Math.min(MAX_PAIRING_SESSION_TTL_MS, Math.max(MIN_PAIRING_SESSION_TTL_MS, value)),
  );
}

function normalizeOptionalName(
  input: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const trimmed = input?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, maxLength);
}

function isoAt(timeMs: number): string {
  return new Date(timeMs).toISOString();
}

function resolvePairingSessionStatus(
  record: PairingSessionRecord,
  nowMs: number,
): PairingSessionStatus {
  if (record.relayUrl.length > 0 && record.resolution === "approved") {
    return "approved";
  }
  if (nowMs >= record.expiresAtMs) {
    return "expired";
  }
  if (record.resolution === "approved") {
    return "approved";
  }
  if (record.resolution === "rejected") {
    return "rejected";
  }
  if (record.claim) {
    return "claim-pending";
  }
  return "waiting-claim";
}

function toPairingSessionView(record: PairingSessionRecord, nowMs: number): PairingSessionView {
  return {
    sessionId: record.sessionId,
    name: record.name,
    createdAt: isoAt(record.createdAtMs),
    ...(typeof record.resolvedAtMs === "number" ? { resolvedAt: isoAt(record.resolvedAtMs) } : {}),
    status: resolvePairingSessionStatus(record, nowMs),
    expiresAt: isoAt(record.expiresAtMs),
    ...(record.claim
      ? {
          requesterName: record.claim.requesterName,
          claimId: record.claim.claimId,
        }
      : {}),
    ...(record.relayUrl ? { relayUrl: record.relayUrl } : {}),
    ...(record.hostDeviceId ? { hostDeviceId: record.hostDeviceId } : {}),
    ...(record.viewerDeviceId ? { viewerDeviceId: record.viewerDeviceId } : {}),
  };
}

function isValidPairingWsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

function prunePairingSessions(nowMs = Date.now()): number {
  let removedCount = 0;
  for (const [sessionId, record] of pairingSessions.entries()) {
    if (record.relayUrl.length > 0 && record.resolution === "approved") {
      continue;
    }
    if (record.expiresAtMs + PAIRING_SESSION_EXPIRED_GRACE_MS > nowMs) {
      continue;
    }
    pairingSessions.delete(sessionId);
    removedCount += 1;
    if (record.claim) {
      pairingClaimSessions.delete(record.claim.claimId);
    }
  }
  return removedCount;
}

export function prunePairingSessionsNow(nowMs = Date.now()): number {
  return prunePairingSessions(nowMs);
}

function readPairingSession(sessionId: string, nowMs: number): PairingResult<PairingSessionRecord> {
  prunePairingSessions(nowMs);
  const record = pairingSessions.get(sessionId);
  if (!record) {
    return fail("not-found", "Pairing session was not found.");
  }
  return succeed(record);
}

export function createPairingSession(
  input: CreatePairingSessionInput,
): PairingResult<PairingSessionCreated> {
  const nowMs = input.nowMs ?? Date.now();
  prunePairingSessions(nowMs);
  const usingRelay =
    typeof input.relayUrl === "string" &&
    input.relayUrl.trim().length > 0 &&
    typeof input.hostDeviceId === "string" &&
    input.hostDeviceId.trim().length > 0 &&
    typeof input.hostIdentityPublicKey === "string" &&
    input.hostIdentityPublicKey.trim().length > 0;
  if (!usingRelay && !isValidPairingWsUrl(input.wsUrl ?? "")) {
    return fail("invalid-ws-url", "Pairing host URL must use ws:// or wss://.");
  }
  const ttlMs = clampTtlMs(input.ttlMs);
  const sessionId = Crypto.randomUUID();
  const secret = Crypto.randomBytes(24).toString("hex");
  const expiresAtMs = nowMs + ttlMs;
  const record: PairingSessionRecord = {
    sessionId,
    secret,
    wsUrl: input.wsUrl ?? "",
    authToken: input.authToken ?? "",
    relayUrl: input.relayUrl ?? "",
    hostDeviceId: input.hostDeviceId ?? "",
    hostIdentityPublicKey: input.hostIdentityPublicKey ?? "",
    name: normalizeOptionalName(input.name, "ace host", MAX_HOST_NAME_LENGTH),
    createdAtMs: nowMs,
    expiresAtMs,
    relayAuthKey: null,
    claim: null,
    resolution: null,
    resolvedAtMs: null,
    viewerDeviceId: null,
    viewerIdentityPublicKey: null,
  };
  pairingSessions.set(sessionId, record);
  return succeed({
    sessionId,
    secret,
    expiresAt: isoAt(expiresAtMs),
    status: "waiting-claim",
    ...(record.relayUrl
      ? {
          relayUrl: record.relayUrl,
          hostDeviceId: record.hostDeviceId,
          hostIdentityPublicKey: record.hostIdentityPublicKey,
        }
      : {}),
  });
}

export function approveRelayPairingRequest(input: {
  readonly sessionId: string;
  readonly viewerDeviceId: string;
  readonly viewerIdentityPublicKey: string;
  readonly routeId: string;
  readonly clientSessionId: string;
  readonly connectionId: string;
  readonly routeAuthIssuedAt: string;
  readonly routeAuthProof: string;
  readonly requesterName?: string;
  readonly nowMs?: number;
}): PairingResult<PairingSessionView> {
  const nowMs = input.nowMs ?? Date.now();
  const recordResult = readPairingSession(input.sessionId, nowMs);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  if (record.viewerDeviceId && record.viewerDeviceId !== input.viewerDeviceId) {
    return fail("already-claimed", "Pairing session is already bound to another device.");
  }
  if (
    record.viewerIdentityPublicKey &&
    record.viewerIdentityPublicKey !== input.viewerIdentityPublicKey
  ) {
    return fail("already-claimed", "Pairing session is already bound to another device key.");
  }
  if (record.resolution === "rejected") {
    return fail("already-claimed", "Pairing session is no longer pending.");
  }
  if (record.resolution !== "approved" && nowMs >= record.expiresAtMs) {
    return fail("expired", "Pairing session has expired.");
  }
  if (record.relayUrl.trim().length === 0) {
    return fail("invalid-secret", "Pairing session is not a relay pairing.");
  }
  let relayAuthKey = record.relayAuthKey;
  if (!relayAuthKey) {
    if (record.secret.trim().length === 0) {
      return fail("invalid-secret", "Relay pairing secret is unavailable.");
    }
    relayAuthKey = deriveRelayPairingAuthKey({
      pairingId: record.sessionId,
      pairingSecret: record.secret,
      hostDeviceId: record.hostDeviceId,
      hostIdentityPublicKey: record.hostIdentityPublicKey,
      viewerDeviceId: input.viewerDeviceId,
      viewerIdentityPublicKey: input.viewerIdentityPublicKey,
    });
  } else if (
    !record.viewerDeviceId ||
    !record.viewerIdentityPublicKey ||
    record.viewerDeviceId !== input.viewerDeviceId ||
    record.viewerIdentityPublicKey !== input.viewerIdentityPublicKey
  ) {
    return fail("already-claimed", "Pairing session is already bound to another device.");
  }
  const proofValid = verifyRelayRouteAuthProof({
    pairingAuthKey: relayAuthKey,
    routeId: input.routeId,
    clientSessionId: input.clientSessionId,
    connectionId: input.connectionId,
    viewerDeviceId: input.viewerDeviceId,
    viewerIdentityPublicKey: input.viewerIdentityPublicKey,
    issuedAt: input.routeAuthIssuedAt,
    proof: input.routeAuthProof,
    nowMs,
  });
  if (!proofValid) {
    return fail("invalid-secret", "Relay pairing proof is invalid.");
  }
  record.claim = {
    claimId: record.claim?.claimId ?? Crypto.randomUUID(),
    requesterName: normalizeOptionalName(
      input.requesterName,
      "Remote device",
      MAX_REQUESTER_NAME_LENGTH,
    ),
    requestedAtMs: nowMs,
  };
  record.viewerDeviceId = input.viewerDeviceId;
  record.viewerIdentityPublicKey = input.viewerIdentityPublicKey;
  record.resolution = "approved";
  record.resolvedAtMs = record.resolvedAtMs ?? nowMs;
  record.relayAuthKey = relayAuthKey;
  if (record.relayUrl.length > 0) {
    record.secret = "";
  }
  return succeed(toPairingSessionView(record, nowMs));
}

export function getPairingSession(
  sessionId: string,
  nowMs = Date.now(),
): PairingResult<PairingSessionView> {
  const recordResult = readPairingSession(sessionId, nowMs);
  if (!recordResult.ok) {
    return recordResult;
  }
  return succeed(toPairingSessionView(recordResult.value, nowMs));
}

export function listPairingSessions(nowMs = Date.now()): ReadonlyArray<PairingSessionView> {
  prunePairingSessions(nowMs);
  return Array.from(pairingSessions.values())
    .toSorted((left, right) => right.createdAtMs - left.createdAtMs)
    .map((record) => toPairingSessionView(record, nowMs));
}

export function resolvePairingSession(input: {
  readonly sessionId: string;
  readonly approve: boolean;
  readonly nowMs?: number;
}): PairingResult<PairingSessionView> {
  const nowMs = input.nowMs ?? Date.now();
  const recordResult = readPairingSession(input.sessionId, nowMs);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  if (nowMs >= record.expiresAtMs) {
    return fail("expired", "Pairing session has expired.");
  }
  if (!record.claim) {
    return fail("claim-missing", "Pairing session has no pending claim.");
  }
  if (record.resolution === null) {
    record.resolution = input.approve ? "approved" : "rejected";
    record.resolvedAtMs = nowMs;
  }
  return succeed(toPairingSessionView(record, nowMs));
}

export function revokePairingSession(input: {
  readonly sessionId: string;
  readonly nowMs?: number;
}): PairingResult<PairingSessionView> {
  const nowMs = input.nowMs ?? Date.now();
  const recordResult = readPairingSession(input.sessionId, nowMs);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  if (nowMs >= record.expiresAtMs) {
    return fail("expired", "Pairing session has expired.");
  }
  record.resolution = "rejected";
  record.resolvedAtMs = nowMs;
  return succeed(toPairingSessionView(record, nowMs));
}

export function claimPairingSession(
  input: ClaimPairingSessionInput,
): PairingResult<PairingClaimCreated> {
  const nowMs = input.nowMs ?? Date.now();
  const recordResult = readPairingSession(input.sessionId, nowMs);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  if (nowMs >= record.expiresAtMs) {
    return fail("expired", "Pairing session has expired.");
  }
  if (record.secret !== input.secret) {
    return fail("invalid-secret", "Pairing secret is invalid.");
  }
  if (record.claim) {
    return fail("already-claimed", "Pairing session already has a pending claim.");
  }
  if (record.resolution !== null) {
    return fail("already-claimed", "Pairing session is no longer pending.");
  }
  const claimId = Crypto.randomUUID();
  const claimRecord: PairingClaimRecord = {
    claimId,
    requesterName: normalizeOptionalName(
      input.requesterName,
      "Remote device",
      MAX_REQUESTER_NAME_LENGTH,
    ),
    requestedAtMs: nowMs,
  };
  record.claim = claimRecord;
  pairingClaimSessions.set(claimId, record.sessionId);
  return succeed({
    claimId,
    status: "pending",
    expiresAt: isoAt(record.expiresAtMs),
  });
}

export function getPairingClaim(
  claimId: string,
  nowMs = Date.now(),
): PairingResult<PairingClaimView> {
  prunePairingSessions(nowMs);
  const sessionId = pairingClaimSessions.get(claimId);
  if (!sessionId) {
    return fail("not-found", "Pairing claim was not found.");
  }
  const record = pairingSessions.get(sessionId);
  if (!record || !record.claim || record.claim.claimId !== claimId) {
    pairingClaimSessions.delete(claimId);
    return fail("not-found", "Pairing claim was not found.");
  }
  if (nowMs >= record.expiresAtMs) {
    return succeed({ claimId, status: "expired" });
  }
  if (record.resolution === "rejected") {
    return succeed({ claimId, status: "rejected" });
  }
  if (record.resolution === "approved") {
    return succeed({
      claimId,
      status: "approved",
      host: {
        name: record.name,
        wsUrl: record.wsUrl,
        authToken: record.authToken,
      },
    });
  }
  return succeed({
    claimId,
    status: "pending",
    expiresAt: isoAt(record.expiresAtMs),
  });
}

export function __resetPairingStoreForTests(): void {
  pairingSessions.clear();
  pairingClaimSessions.clear();
}

export async function persistPairingSessionsToDatabase(repo: {
  upsert: (session: {
    sessionId: string;
    secret: string;
    wsUrl: string;
    authToken: string;
    relayUrl: string;
    hostDeviceId: string;
    hostIdentityPublicKey: string;
    name: string;
    createdAtMs: number;
    expiresAtMs: number;
    relayAuthKey: string | null;
    claimId: string | null;
    claimRequesterName: string | null;
    claimRequestedAtMs: number | null;
    resolution: string | null;
    resolvedAtMs: number | null;
    viewerDeviceId: string | null;
    viewerIdentityPublicKey: string | null;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}): Promise<void> {
  await Effect.runPromise(
    Effect.all(
      Array.from(pairingSessions.values()).map((session) =>
        repo.upsert({
          sessionId: session.sessionId,
          secret: session.secret,
          wsUrl: session.wsUrl,
          authToken: session.authToken,
          relayUrl: session.relayUrl,
          hostDeviceId: session.hostDeviceId,
          hostIdentityPublicKey: session.hostIdentityPublicKey,
          name: session.name,
          createdAtMs: session.createdAtMs,
          expiresAtMs: session.expiresAtMs,
          relayAuthKey: session.relayAuthKey,
          claimId: session.claim?.claimId ?? null,
          claimRequesterName: session.claim?.requesterName ?? null,
          claimRequestedAtMs: session.claim?.requestedAtMs ?? null,
          resolution: session.resolution,
          resolvedAtMs: session.resolvedAtMs,
          viewerDeviceId: session.viewerDeviceId,
          viewerIdentityPublicKey: session.viewerIdentityPublicKey,
        }),
      ),
      { concurrency: "unbounded" },
    ),
  );
}

export async function loadPairingSessionsFromDatabase(repo: {
  getAll: () => Effect.Effect<
    ReadonlyArray<{
      sessionId: string;
      secret: string;
      wsUrl: string;
      authToken: string;
      relayUrl: string;
      hostDeviceId: string;
      hostIdentityPublicKey: string;
      name: string;
      createdAtMs: number;
      expiresAtMs: number;
      relayAuthKey: string | null;
      claimId: string | null;
      claimRequesterName: string | null;
      claimRequestedAtMs: number | null;
      resolution: string | null;
      resolvedAtMs: number | null;
      viewerDeviceId: string | null;
      viewerIdentityPublicKey: string | null;
    }>,
    ProjectionRepositoryError
  >;
}): Promise<void> {
  const sessions = await Effect.runPromise(repo.getAll());
  for (const session of sessions) {
    pairingSessions.set(session.sessionId, {
      sessionId: session.sessionId,
      secret: session.secret,
      wsUrl: session.wsUrl,
      authToken: session.authToken,
      relayUrl: session.relayUrl,
      hostDeviceId: session.hostDeviceId,
      hostIdentityPublicKey: session.hostIdentityPublicKey,
      name: session.name,
      createdAtMs: session.createdAtMs,
      expiresAtMs: session.expiresAtMs,
      relayAuthKey: session.relayAuthKey,
      claim: session.claimId
        ? {
            claimId: session.claimId,
            requesterName: session.claimRequesterName ?? "",
            requestedAtMs: session.claimRequestedAtMs ?? 0,
          }
        : null,
      resolution: session.resolution as "approved" | "rejected" | null,
      resolvedAtMs: session.resolvedAtMs,
      viewerDeviceId: session.viewerDeviceId,
      viewerIdentityPublicKey: session.viewerIdentityPublicKey,
    });
    if (session.claimId) {
      pairingClaimSessions.set(session.claimId, session.sessionId);
    }
  }
}
