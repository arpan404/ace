import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { randomUUID } from "@ace/shared/ids";
import {
  appendWsAuthToken,
  buildPairingPayload,
  normalizeWsUrl,
  parseHostConnectionQrPayload,
  parseHostDraftFromQrPayload,
  readPairingClaim,
  requestPairingClaim,
  resolveHostDisplayName,
  splitWsUrlAuthToken,
  waitForPairingApproval,
  type HostConnectionDraft,
  type HostPairingPayload,
  wsUrlToBrowserBaseUrl,
} from "@ace/shared/hostConnections";

import { resolveServerUrl } from "./utils";

const REMOTE_HOSTS_STORAGE_KEY = "ace.remote-hosts.v1";

export interface RemoteHostInstance {
  readonly id: string;
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly iconGlyph?: "folder" | "terminal" | "code" | "flask" | "rocket" | "package";
  readonly iconColor?: "slate" | "blue" | "violet" | "emerald" | "amber" | "rose";
  readonly createdAt: string;
  readonly lastConnectedAt?: string;
}

export interface HostPairingSessionStatus {
  readonly sessionId: string;
  readonly status: "waiting-claim" | "claim-pending" | "approved" | "rejected" | "expired";
  readonly expiresAt: string;
  readonly requesterName?: string;
  readonly claimId?: string;
}

export interface HostPairingSessionCreated extends HostPairingSessionStatus {
  readonly secret: string;
  readonly claimUrl?: string;
  readonly pollingUrl?: string;
}

export interface PairingAdvertisedEndpoint {
  readonly wsUrl: string;
}

function isRemoteIconGlyph(
  value: unknown,
): value is "folder" | "terminal" | "code" | "flask" | "rocket" | "package" {
  return (
    value === "folder" ||
    value === "terminal" ||
    value === "code" ||
    value === "flask" ||
    value === "rocket" ||
    value === "package"
  );
}

function isRemoteIconColor(
  value: unknown,
): value is "slate" | "blue" | "violet" | "emerald" | "amber" | "rose" {
  return (
    value === "slate" ||
    value === "blue" ||
    value === "violet" ||
    value === "emerald" ||
    value === "amber" ||
    value === "rose"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveWsProtocol(): "ws" | "wss" {
  return window.location.protocol === "https:" ? "wss" : "ws";
}

export function createRemoteHostInstance(
  draft: HostConnectionDraft & {
    readonly iconGlyph?: "folder" | "terminal" | "code" | "flask" | "rocket" | "package";
    readonly iconColor?: "slate" | "blue" | "violet" | "emerald" | "amber" | "rose";
  },
  existing?: RemoteHostInstance,
  nowIso = new Date().toISOString(),
): RemoteHostInstance {
  const normalizedWsUrl = normalizeWsUrl(draft.wsUrl);
  const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(normalizedWsUrl);
  const explicitToken = draft.authToken?.trim() ?? "";
  return {
    id: existing?.id ?? randomUUID(),
    name: resolveHostDisplayName(draft.name, wsUrl),
    wsUrl,
    authToken: explicitToken || embeddedAuthToken || existing?.authToken || "",
    ...(draft.iconGlyph ? { iconGlyph: draft.iconGlyph } : {}),
    ...(draft.iconColor ? { iconColor: draft.iconColor } : {}),
    createdAt: existing?.createdAt ?? nowIso,
    ...(existing?.lastConnectedAt ? { lastConnectedAt: existing.lastConnectedAt } : {}),
  };
}

function decodeRemoteHostInstance(value: unknown): RemoteHostInstance | null {
  if (!isRecord(value) || typeof value.wsUrl !== "string") {
    return null;
  }
  const nowIso = new Date().toISOString();
  const existing: RemoteHostInstance = {
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : randomUUID(),
    name: typeof value.name === "string" ? value.name : "",
    wsUrl: value.wsUrl,
    authToken: typeof value.authToken === "string" ? value.authToken : "",
    ...(isRemoteIconGlyph(value.iconGlyph) ? { iconGlyph: value.iconGlyph } : {}),
    ...(isRemoteIconColor(value.iconColor) ? { iconColor: value.iconColor } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso,
    ...(typeof value.lastConnectedAt === "string"
      ? { lastConnectedAt: value.lastConnectedAt }
      : {}),
  };

  try {
    return createRemoteHostInstance(
      {
        name: existing.name,
        wsUrl: existing.wsUrl,
        authToken: existing.authToken,
        ...(existing.iconGlyph ? { iconGlyph: existing.iconGlyph } : {}),
        ...(existing.iconColor ? { iconColor: existing.iconColor } : {}),
      },
      existing,
      nowIso,
    );
  } catch {
    return null;
  }
}

export function loadRemoteHostInstances(): RemoteHostInstance[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(REMOTE_HOSTS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((candidate) => decodeRemoteHostInstance(candidate))
      .filter((candidate): candidate is RemoteHostInstance => candidate !== null);
  } catch {
    return [];
  }
}

export function persistRemoteHostInstances(hosts: ReadonlyArray<RemoteHostInstance>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(REMOTE_HOSTS_STORAGE_KEY, JSON.stringify(hosts));
}

export function resolveActiveWsUrl(): string {
  const resolved = resolveServerUrl({
    protocol: resolveWsProtocol(),
    pathname: "/ws",
  });
  return normalizeWsUrl(resolved);
}

export function resolveLocalDeviceWsUrl(): string {
  if (typeof window !== "undefined" && window.desktopBridge?.getWsUrl) {
    try {
      const bridged = window.desktopBridge.getWsUrl()?.trim();
      if (bridged && bridged.length > 0) {
        return normalizeWsUrl(bridged);
      }
    } catch {
      // Ignore bridge read errors and fall back to active transport resolution.
    }
  }
  return resolveActiveWsUrl();
}

export function resolveHostConnectionWsUrl(
  host: Pick<RemoteHostInstance, "wsUrl" | "authToken">,
): string {
  return appendWsAuthToken(host.wsUrl, host.authToken);
}

export function isHostConnectionActive(
  host: Pick<RemoteHostInstance, "wsUrl" | "authToken">,
  activeWsUrl: string,
): boolean {
  return resolveHostConnectionWsUrl(host) === normalizeWsUrl(activeWsUrl);
}

export function connectToWsHost(targetWsUrl: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM, normalizeWsUrl(targetWsUrl));
  window.location.assign(nextUrl.toString());
}

export async function verifyWsHostConnection(
  targetWsUrl: string,
  options?: { readonly timeoutMs?: number },
): Promise<void> {
  const normalizedTarget = normalizeWsUrl(targetWsUrl);
  const { wsUrl, authToken } = splitWsUrlAuthToken(normalizedTarget);
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 5_000);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      readHostPairingAdvertisedEndpoint({
        wsUrl,
        ...(authToken ? { authToken } : {}),
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Connection check timed out after ${String(timeoutMs)}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function buildHostSharePayload(input: {
  readonly name?: string;
  readonly wsUrl: string;
  readonly authToken?: string;
}): string {
  const normalized = normalizeWsUrl(input.wsUrl);
  const { wsUrl, authToken: embeddedAuthToken } = splitWsUrlAuthToken(normalized);
  const name = input.name?.trim() ?? "";
  const authToken = input.authToken?.trim() || embeddedAuthToken;
  return JSON.stringify(
    {
      ...(name.length > 0 ? { name } : {}),
      wsUrl,
      ...(authToken.length > 0 ? { token: authToken } : {}),
    },
    null,
    2,
  );
}

function resolvePairingApiBaseUrl(wsUrl: string): string {
  return wsUrlToBrowserBaseUrl(wsUrl);
}

function buildPairingRequestHeaders(authToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedToken = authToken?.trim() ?? "";
  if (trimmedToken.length > 0) {
    headers.Authorization = `Bearer ${trimmedToken}`;
  }
  return headers;
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
    throw new Error("Pairing endpoint returned malformed JSON.");
  }
}

function assertPairingSessionStatus(payload: unknown): HostPairingSessionStatus {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Pairing session response was invalid.");
  }
  const value = payload as {
    sessionId?: unknown;
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
    throw new Error("Pairing session response was missing required fields.");
  }
  if (
    value.status !== "waiting-claim" &&
    value.status !== "claim-pending" &&
    value.status !== "approved" &&
    value.status !== "rejected" &&
    value.status !== "expired"
  ) {
    throw new Error("Pairing session response had an unknown status.");
  }
  return {
    sessionId: value.sessionId,
    status: value.status,
    expiresAt: value.expiresAt,
    ...(typeof value.requesterName === "string" ? { requesterName: value.requesterName } : {}),
    ...(typeof value.claimId === "string" ? { claimId: value.claimId } : {}),
  };
}

function assertPairingSessionCreated(payload: unknown): HostPairingSessionCreated {
  const status = assertPairingSessionStatus(payload);
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Pairing session response was invalid.");
  }
  const value = payload as { secret?: unknown; claimUrl?: unknown };
  if (typeof value.secret !== "string" || typeof value.claimUrl !== "string") {
    throw new Error("Pairing session creation response was missing required fields.");
  }
  return {
    ...status,
    secret: value.secret,
    claimUrl: value.claimUrl,
  };
}

function assertPairingAdvertisedEndpoint(payload: unknown): PairingAdvertisedEndpoint {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Pairing endpoint response was invalid.");
  }
  const value = payload as { wsUrl?: unknown };
  if (typeof value.wsUrl !== "string") {
    throw new Error("Pairing endpoint response was missing wsUrl.");
  }
  return {
    wsUrl: value.wsUrl,
  };
}

async function requestPairingSessionJson(
  input: {
    readonly wsUrl: string;
    readonly authToken?: string;
  },
  init: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  },
): Promise<unknown> {
  const baseUrl = resolvePairingApiBaseUrl(input.wsUrl);
  const endpoint = new URL(init.path, baseUrl).toString();
  const response = await fetch(endpoint, {
    method: init.method,
    headers: buildPairingRequestHeaders(input.authToken),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const errorMessage = parsePairingErrorMessage(payload);
    throw new Error(
      errorMessage ?? `Pairing request failed with status ${String(response.status)}.`,
    );
  }
  return payload;
}

export async function createHostPairingSession(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly name?: string;
}): Promise<HostPairingSessionCreated> {
  const payload = await requestPairingSessionJson(
    {
      wsUrl: input.wsUrl,
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
    {
      method: "POST",
      path: "/api/pairing/sessions",
      body: {
        wsUrl: normalizeWsUrl(input.wsUrl),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      },
    },
  );
  return assertPairingSessionCreated(payload);
}

export async function readHostPairingAdvertisedEndpoint(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
}): Promise<PairingAdvertisedEndpoint> {
  const normalizedWsUrl = normalizeWsUrl(input.wsUrl);
  const payload = await requestPairingSessionJson(
    {
      wsUrl: normalizedWsUrl,
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
    {
      method: "GET",
      path: `/api/pairing/advertised-endpoint?wsUrl=${encodeURIComponent(normalizedWsUrl)}`,
    },
  );
  return assertPairingAdvertisedEndpoint(payload);
}

function encodeBase64UrlUtf8(input: string): string {
  const utf8 = encodeURIComponent(input).replace(/%([0-9A-F]{2})/g, (_, byte) =>
    String.fromCharCode(Number.parseInt(byte, 16)),
  );
  return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function buildHostPairingConnectionString(pairing: HostPairingPayload): string {
  const payload = JSON.stringify({
    ...(pairing.name?.trim() ? { name: pairing.name.trim() } : {}),
    sessionId: pairing.sessionId,
    secret: pairing.secret,
    ...(pairing.claimUrl ? { claimUrl: new URL(pairing.claimUrl).toString() } : {}),
    ...(pairing.pollingUrl ? { pollingUrl: pairing.pollingUrl } : {}),
  });
  const pairingUrl = new URL("ace://pair");
  pairingUrl.searchParams.set("p", encodeBase64UrlUtf8(payload));
  return pairingUrl.toString();
}

export async function resolvePairingHostConnection(
  pairing: HostPairingPayload,
  options?: {
    readonly requesterName?: string;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  },
): Promise<HostConnectionDraft> {
  const claimOptions = options?.requesterName
    ? { requesterName: options.requesterName }
    : undefined;
  const receipt = await requestPairingClaim(pairing, claimOptions);

  let approvalOptions:
    | {
        timeoutMs?: number;
        pollIntervalMs?: number;
      }
    | undefined;
  if (options?.timeoutMs !== undefined || options?.pollIntervalMs !== undefined) {
    approvalOptions = {};
    if (options.timeoutMs !== undefined) {
      approvalOptions.timeoutMs = options.timeoutMs;
    }
    if (options.pollIntervalMs !== undefined) {
      approvalOptions.pollIntervalMs = options.pollIntervalMs;
    }
  }

  return waitForPairingApproval(receipt, approvalOptions);
}

export async function readHostPairingSession(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly sessionId: string;
}): Promise<HostPairingSessionStatus> {
  const payload = await requestPairingSessionJson(
    {
      wsUrl: input.wsUrl,
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
    {
      method: "GET",
      path: `/api/pairing/sessions/${encodeURIComponent(input.sessionId)}`,
    },
  );
  return assertPairingSessionStatus(payload);
}

export async function resolveHostPairingSession(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
  readonly sessionId: string;
  readonly approve: boolean;
}): Promise<HostPairingSessionStatus> {
  const payload = await requestPairingSessionJson(
    {
      wsUrl: input.wsUrl,
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
    {
      method: "POST",
      path: `/api/pairing/sessions/${encodeURIComponent(input.sessionId)}/resolve`,
      body: {
        approve: input.approve,
      },
    },
  );
  return assertPairingSessionStatus(payload);
}

export { normalizeWsUrl, parseHostDraftFromQrPayload, splitWsUrlAuthToken };
export {
  buildPairingPayload,
  parseHostConnectionQrPayload,
  readPairingClaim,
  requestPairingClaim,
  waitForPairingApproval,
};
export type { HostConnectionDraft, HostPairingPayload };
