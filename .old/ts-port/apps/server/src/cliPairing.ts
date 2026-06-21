import { WS_METHODS } from "@ace/contracts";
import {
  buildPairingPayload,
  normalizeWsUrl,
  splitWsUrlAuthToken,
  wsUrlToBrowserBaseUrl,
  type HostPairingPayload,
} from "@ace/shared/hostConnections";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { RelayRpcTransport } from "@ace/shared/relayRpcTransport";
import { Data } from "effect";

import { loadCliRelayDeviceIdentity } from "./cliRelayIdentity";

export class CliPairingCommandError extends Data.TaggedError("CliPairingCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CliPairingSessionStatus {
  readonly sessionId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly status: "waiting-claim" | "claim-pending" | "approved" | "rejected" | "expired";
  readonly expiresAt: string;
  readonly requesterName?: string;
  readonly claimId?: string;
}

export interface CliHostPingResult {
  readonly status: "available" | "unauthenticated" | "unavailable";
  readonly latencyMs: number;
  readonly detail?: string;
}

export interface CliPairingSessionCreated extends CliPairingSessionStatus {
  readonly secret: string;
  readonly claimUrl?: string;
  readonly pollingUrl?: string;
  readonly advertisedWsUrl: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
  readonly connectionString: string;
}

function parsePairingErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const errorValue = (payload as { error?: unknown }).error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue.trim();
  }
  return null;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliPairingCommandError({
      message: "Pairing endpoint returned malformed JSON.",
    });
  }
}

function assertPairingSessionStatus(payload: unknown): CliPairingSessionStatus {
  if (typeof payload !== "object" || payload === null) {
    throw new CliPairingCommandError({
      message: "Pairing session response was invalid.",
    });
  }
  const value = payload as {
    sessionId?: unknown;
    name?: unknown;
    createdAt?: unknown;
    resolvedAt?: unknown;
    status?: unknown;
    expiresAt?: unknown;
    requesterName?: unknown;
    claimId?: unknown;
  };
  if (
    typeof value.sessionId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new CliPairingCommandError({
      message: "Pairing session response was missing required fields.",
    });
  }
  const name = typeof value.name === "string" ? value.name : "ace host";
  const createdAt =
    typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  if (
    value.status !== "waiting-claim" &&
    value.status !== "claim-pending" &&
    value.status !== "approved" &&
    value.status !== "rejected" &&
    value.status !== "expired"
  ) {
    throw new CliPairingCommandError({
      message: "Pairing session response had an unknown status.",
    });
  }
  return {
    sessionId: value.sessionId,
    name,
    createdAt,
    ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
    status: value.status,
    expiresAt: value.expiresAt,
    ...(typeof value.requesterName === "string" ? { requesterName: value.requesterName } : {}),
    ...(typeof value.claimId === "string" ? { claimId: value.claimId } : {}),
  };
}

function assertPairingSessionList(payload: unknown): ReadonlyArray<CliPairingSessionStatus> {
  if (!Array.isArray(payload)) {
    throw new CliPairingCommandError({
      message: "Pairing session list response was invalid.",
    });
  }
  return payload.map((entry) => assertPairingSessionStatus(entry));
}

function assertPairingSessionCreated(payload: unknown): {
  readonly session: CliPairingSessionStatus;
  readonly secret: string;
  readonly claimUrl?: string;
  readonly pollingUrl?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
} {
  const session = assertPairingSessionStatus(payload);
  if (typeof payload !== "object" || payload === null) {
    throw new CliPairingCommandError({
      message: "Pairing session response was invalid.",
    });
  }
  const value = payload as {
    secret?: unknown;
    claimUrl?: unknown;
    pollingUrl?: unknown;
    relayUrl?: unknown;
    hostDeviceId?: unknown;
    hostIdentityPublicKey?: unknown;
  };
  if (typeof value.secret !== "string") {
    throw new CliPairingCommandError({
      message: "Pairing session creation response was missing required fields.",
    });
  }
  const claimUrl = typeof value.claimUrl === "string" ? value.claimUrl : undefined;
  const pollingUrl = typeof value.pollingUrl === "string" ? value.pollingUrl : undefined;
  const relayUrl = typeof value.relayUrl === "string" ? value.relayUrl : undefined;
  const hostDeviceId = typeof value.hostDeviceId === "string" ? value.hostDeviceId : undefined;
  const hostIdentityPublicKey =
    typeof value.hostIdentityPublicKey === "string" ? value.hostIdentityPublicKey : undefined;
  if (!claimUrl && !pollingUrl && (!relayUrl || !hostDeviceId || !hostIdentityPublicKey)) {
    throw new CliPairingCommandError({
      message: "Pairing session creation response did not include a polling endpoint.",
    });
  }
  return {
    session,
    secret: value.secret,
    ...(claimUrl ? { claimUrl } : {}),
    ...(pollingUrl ? { pollingUrl } : {}),
    ...(relayUrl ? { relayUrl } : {}),
    ...(hostDeviceId ? { hostDeviceId } : {}),
    ...(hostIdentityPublicKey ? { hostIdentityPublicKey } : {}),
  };
}

function assertPairingAdvertisedEndpoint(payload: unknown): { readonly wsUrl: string } {
  if (typeof payload !== "object" || payload === null) {
    throw new CliPairingCommandError({
      message: "Pairing endpoint response was invalid.",
    });
  }
  const value = payload as { wsUrl?: unknown };
  if (typeof value.wsUrl !== "string") {
    throw new CliPairingCommandError({
      message: "Pairing endpoint response was missing wsUrl.",
    });
  }
  return {
    wsUrl: value.wsUrl,
  };
}

function buildPairingRequestHeaders(authToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken.length > 0) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function resolveBaseUrl(wsUrl: string): string {
  return wsUrlToBrowserBaseUrl(wsUrl);
}

function buildConnectionString(pairing: HostPairingPayload): string {
  const encodedPayload = Buffer.from(buildPairingPayload(pairing), "utf8").toString("base64url");
  return `ace://pair?p=${encodedPayload}`;
}

async function requestPairingSessionJson(input: {
  readonly wsUrl: string;
  readonly authToken: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}): Promise<unknown> {
  const endpoint = new URL(input.path, resolveBaseUrl(input.wsUrl)).toString();
  const response = await fetch(endpoint, {
    method: input.method,
    headers: buildPairingRequestHeaders(input.authToken),
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CliPairingCommandError({
      message:
        parsePairingErrorMessage(payload) ??
        `Pairing request failed with status ${String(response.status)}.`,
    });
  }
  return payload;
}

async function requestPairingSessionStatus(input: {
  readonly wsUrl: string;
  readonly authToken: string;
  readonly path: string;
  readonly timeoutMs: number;
}): Promise<{ readonly response: Response; readonly payload: unknown }> {
  const endpoint = new URL(input.path, resolveBaseUrl(input.wsUrl)).toString();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(100, input.timeoutMs),
  );
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: buildPairingRequestHeaders(input.authToken),
      signal: controller.signal,
    });
    const payload = await parseJsonResponse(response);
    return { response, payload };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function normalizeConnectionInput(input: { readonly wsUrl: string; readonly authToken?: string }) {
  const normalized = normalizeWsUrl(input.wsUrl);
  const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(normalized);
  const explicitToken = input.authToken?.trim() ?? "";
  return {
    wsUrl,
    authToken: explicitToken.length > 0 ? explicitToken : embeddedAuthToken,
  };
}

export async function createCliPairingSession(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly name?: string;
  readonly relayUrl?: string;
}): Promise<CliPairingSessionCreated> {
  const normalized = normalizeConnectionInput({
    wsUrl: input.wsUrl,
    ...(input.authToken ? { authToken: input.authToken } : {}),
  });
  const createdPayload = await requestPairingSessionJson({
    wsUrl: normalized.wsUrl,
    authToken: normalized.authToken,
    method: "POST",
    path: "/api/pairing/sessions",
    body: {
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.relayUrl?.trim() ? { relayUrl: input.relayUrl.trim() } : {}),
    },
  });
  const created = assertPairingSessionCreated(createdPayload);
  const advertisedWsUrl =
    created.relayUrl ??
    assertPairingAdvertisedEndpoint(
      await requestPairingSessionJson({
        wsUrl: normalized.wsUrl,
        authToken: normalized.authToken,
        method: "GET",
        path: `/api/pairing/advertised-endpoint?wsUrl=${encodeURIComponent(normalized.wsUrl)}`,
      }),
    ).wsUrl;

  return {
    ...created.session,
    secret: created.secret,
    ...(created.claimUrl ? { claimUrl: created.claimUrl } : {}),
    ...(created.pollingUrl ? { pollingUrl: created.pollingUrl } : {}),
    advertisedWsUrl,
    ...(created.relayUrl ? { relayUrl: created.relayUrl } : {}),
    ...(created.hostDeviceId ? { hostDeviceId: created.hostDeviceId } : {}),
    ...(created.hostIdentityPublicKey
      ? { hostIdentityPublicKey: created.hostIdentityPublicKey }
      : {}),
    connectionString: buildConnectionString({
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      sessionId: created.session.sessionId,
      secret: created.secret,
      ...(created.claimUrl ? { claimUrl: created.claimUrl } : {}),
      ...(created.pollingUrl ? { pollingUrl: created.pollingUrl } : {}),
      ...(created.relayUrl ? { relayUrl: created.relayUrl } : {}),
      ...(created.hostDeviceId ? { hostDeviceId: created.hostDeviceId } : {}),
      ...(created.hostIdentityPublicKey
        ? { hostIdentityPublicKey: created.hostIdentityPublicKey }
        : {}),
      expiresAt: created.session.expiresAt,
      ...(!created.relayUrl ? { wsUrl: advertisedWsUrl } : {}),
    }),
  };
}

export async function revokeCliPairingSession(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly sessionId: string;
}): Promise<CliPairingSessionStatus> {
  const normalized = normalizeConnectionInput({
    wsUrl: input.wsUrl,
    ...(input.authToken ? { authToken: input.authToken } : {}),
  });
  const payload = await requestPairingSessionJson({
    wsUrl: normalized.wsUrl,
    authToken: normalized.authToken,
    method: "POST",
    path: `/api/pairing/sessions/${encodeURIComponent(input.sessionId)}/revoke`,
  });
  return assertPairingSessionStatus(payload);
}

export async function listCliPairingSessions(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
}): Promise<ReadonlyArray<CliPairingSessionStatus>> {
  const normalized = normalizeConnectionInput({
    wsUrl: input.wsUrl,
    ...(input.authToken ? { authToken: input.authToken } : {}),
  });
  const payload = await requestPairingSessionJson({
    wsUrl: normalized.wsUrl,
    authToken: normalized.authToken,
    method: "GET",
    path: "/api/pairing/sessions",
  });
  return assertPairingSessionList(payload);
}

export async function pingCliHostConnection(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly timeoutMs?: number;
  readonly stateDir?: string;
}): Promise<CliHostPingResult> {
  const normalized = normalizeConnectionInput({
    wsUrl: input.wsUrl,
    ...(input.authToken ? { authToken: input.authToken } : {}),
  });
  const timeoutMs = Math.max(100, input.timeoutMs ?? 4_000);
  const startedAt = Date.now();
  if (parseRelayConnectionUrl(normalized.wsUrl)) {
    if (!input.stateDir?.trim()) {
      return {
        status: "unavailable",
        latencyMs: Date.now() - startedAt,
        detail: "Relay ping requires a CLI state directory.",
      };
    }
    const stateDir = input.stateDir.trim();
    const transport = new RelayRpcTransport({
      connectionUrl: normalized.wsUrl,
      clientSessionId: `ace-cli-ping-${Date.now().toString(36)}`,
      connectionId: `ace-cli-connection-${Date.now().toString(36)}`,
      deviceName: "ace cli",
      loadIdentity: () => loadCliRelayDeviceIdentity(stateDir),
    });
    try {
      await Promise.race([
        transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Relay ping timed out after ${String(timeoutMs)}ms.`));
          }, timeoutMs);
        }),
      ]);
      return {
        status: "available",
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: "unavailable",
        latencyMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : "Relay ping failed.",
      };
    } finally {
      await transport.dispose().catch(() => undefined);
    }
  }
  try {
    const { response, payload } = await requestPairingSessionStatus({
      wsUrl: normalized.wsUrl,
      authToken: normalized.authToken,
      path: `/api/pairing/advertised-endpoint?wsUrl=${encodeURIComponent(normalized.wsUrl)}`,
      timeoutMs,
    });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      assertPairingAdvertisedEndpoint(payload);
      return {
        status: "available",
        latencyMs,
      };
    }
    const message = parsePairingErrorMessage(payload) ?? `HTTP ${String(response.status)}`;
    if (response.status === 401 || message.toLowerCase().includes("unauthorized")) {
      return {
        status: "unauthenticated",
        latencyMs,
        detail: message,
      };
    }
    return {
      status: "unavailable",
      latencyMs,
      detail: message,
    };
  } catch (error) {
    return {
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : "Ping request failed.",
    };
  }
}
