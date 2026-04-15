import * as Crypto from "node:crypto";
import { Effect } from "effect";

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
  readonly secret: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  claim: PairingClaimRecord | null;
  resolution: "approved" | "rejected" | null;
  resolvedAtMs: number | null;
}

const pairingSessions = new Map<string, PairingSessionRecord>();
const pairingClaimSessions = new Map<string, string>();

export interface CreatePairingSessionInput {
  readonly wsUrl: string;
  readonly authToken: string;
  readonly name?: string;
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

export interface PairingSessionCreated {
  readonly sessionId: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly status: PairingSessionStatus;
}

export interface PairingSessionView {
  readonly sessionId: string;
  readonly status: PairingSessionStatus;
  readonly expiresAt: string;
  readonly requesterName?: string | undefined;
  readonly claimId?: string | undefined;
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
    status: resolvePairingSessionStatus(record, nowMs),
    expiresAt: isoAt(record.expiresAtMs),
    ...(record.claim
      ? {
          requesterName: record.claim.requesterName,
          claimId: record.claim.claimId,
        }
      : {}),
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

function prunePairingSessions(nowMs = Date.now()): void {
  for (const [sessionId, record] of pairingSessions.entries()) {
    if (record.expiresAtMs + PAIRING_SESSION_EXPIRED_GRACE_MS > nowMs) {
      continue;
    }
    pairingSessions.delete(sessionId);
    if (record.claim) {
      pairingClaimSessions.delete(record.claim.claimId);
    }
  }
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
  if (!isValidPairingWsUrl(input.wsUrl)) {
    return fail("invalid-ws-url", "Pairing host URL must use ws:// or wss://.");
  }
  const ttlMs = clampTtlMs(input.ttlMs);
  const sessionId = Crypto.randomUUID();
  const secret = Crypto.randomBytes(24).toString("hex");
  const expiresAtMs = nowMs + ttlMs;
  const record: PairingSessionRecord = {
    sessionId,
    secret,
    wsUrl: input.wsUrl,
    authToken: input.authToken,
    name: normalizeOptionalName(input.name, "ace host", MAX_HOST_NAME_LENGTH),
    createdAtMs: nowMs,
    expiresAtMs,
    claim: null,
    resolution: null,
    resolvedAtMs: null,
  };
  pairingSessions.set(sessionId, record);
  return succeed({
    sessionId,
    secret,
    expiresAt: isoAt(expiresAtMs),
    status: "waiting-claim",
  });
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
    name: string;
    createdAtMs: number;
    expiresAtMs: number;
    claimId: string | null;
    claimRequesterName: string | null;
    claimRequestedAtMs: number | null;
    resolution: string | null;
    resolvedAtMs: number | null;
  }) => Effect.Effect<void, never>;
}): Promise<void> {
  await Effect.runPromise(
    Effect.all(
      Array.from(pairingSessions.values()).map((session) =>
        repo.upsert({
          sessionId: session.sessionId,
          secret: session.secret,
          wsUrl: session.wsUrl,
          authToken: session.authToken,
          name: session.name,
          createdAtMs: session.createdAtMs,
          expiresAtMs: session.expiresAtMs,
          claimId: session.claim?.claimId ?? null,
          claimRequesterName: session.claim?.requesterName ?? null,
          claimRequestedAtMs: session.claim?.requestedAtMs ?? null,
          resolution: session.resolution,
          resolvedAtMs: session.resolvedAtMs,
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
      name: string;
      createdAtMs: number;
      expiresAtMs: number;
      claimId: string | null;
      claimRequesterName: string | null;
      claimRequestedAtMs: number | null;
      resolution: string | null;
      resolvedAtMs: number | null;
    }>,
    never
  >;
}): Promise<void> {
  const sessions = await Effect.runPromise(repo.getAll());
  for (const session of sessions) {
    pairingSessions.set(session.sessionId, {
      sessionId: session.sessionId,
      secret: session.secret,
      wsUrl: session.wsUrl,
      authToken: session.authToken,
      name: session.name,
      createdAtMs: session.createdAtMs,
      expiresAtMs: session.expiresAtMs,
      claim: session.claimId
        ? {
            claimId: session.claimId,
            requesterName: session.claimRequesterName ?? "",
            requestedAtMs: session.claimRequestedAtMs ?? 0,
          }
        : null,
      resolution: session.resolution as "approved" | "rejected" | null,
      resolvedAtMs: session.resolvedAtMs,
    });
    if (session.claimId) {
      pairingClaimSessions.set(session.claimId, session.sessionId);
    }
  }
}
