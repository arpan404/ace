import { randomUUID } from "@ace/shared/ids";
import { WS_METHODS } from "@ace/contracts";
import {
  appendWsAuthToken,
  buildRelayHostConnectionDraft,
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
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { RelayRpcTransport } from "@ace/shared/relayRpcTransport";

import { clearActiveWsUrlOverride, resolveServerUrl } from "./utils";
import { loadWebRelayDeviceIdentity } from "./relayDeviceIdentity";

const REMOTE_HOSTS_STORAGE_KEY = "ace.remote-hosts.v1";
const CONNECTED_REMOTE_HOST_IDS_STORAGE_KEY = "ace.connected-remote-host-ids.v1";
const LEGACY_PINNED_REMOTE_HOST_IDS_STORAGE_KEY = "ace.pinned-remote-host-ids.v1";
export const REMOTE_HOSTS_CHANGED_EVENT = "ace:remote-hosts-changed";
export const CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT = "ace:connected-remote-host-ids-changed";

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

export interface HostPairingSessionSummary extends HostPairingSessionStatus {
  readonly name: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly viewerDeviceId?: string;
}

export interface HostPairingSessionCreated extends HostPairingSessionStatus {
  readonly secret: string;
  readonly claimUrl?: string;
  readonly pollingUrl?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
}

export interface PairingAdvertisedEndpoint {
  readonly wsUrl: string;
}

function emitRemoteHostStorageChange(eventName: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(eventName));
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

function createRelayProbeId(prefix: string): string {
  const randomSuffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomSuffix}`;
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
  emitRemoteHostStorageChange(REMOTE_HOSTS_CHANGED_EVENT);
}

function decodeStoredHostIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const deduped = new Set<string>();
    for (const value of parsed) {
      if (typeof value === "string" && value.length > 0) {
        deduped.add(value);
      }
    }
    return [...deduped];
  } catch {
    return [];
  }
}

export function loadConnectedRemoteHostIds(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const connectedRaw = window.localStorage.getItem(CONNECTED_REMOTE_HOST_IDS_STORAGE_KEY);
  if (connectedRaw !== null) {
    return decodeStoredHostIds(connectedRaw);
  }
  return decodeStoredHostIds(
    window.localStorage.getItem(LEGACY_PINNED_REMOTE_HOST_IDS_STORAGE_KEY),
  );
}

export function persistConnectedRemoteHostIds(hostIds: ReadonlyArray<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  const deduped = new Set<string>();
  for (const hostId of hostIds) {
    const trimmed = hostId.trim();
    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }
  window.localStorage.setItem(CONNECTED_REMOTE_HOST_IDS_STORAGE_KEY, JSON.stringify([...deduped]));
  emitRemoteHostStorageChange(CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT);
}

export function loadPinnedRemoteHostIds(): string[] {
  return loadConnectedRemoteHostIds();
}

export function persistPinnedRemoteHostIds(hostIds: ReadonlyArray<string>): void {
  persistConnectedRemoteHostIds(hostIds);
}

export function resolveActiveWsUrl(): string {
  const resolved = resolveServerUrl({
    protocol: resolveWsProtocol(),
    pathname: "/ws",
  });
  return normalizeWsUrl(resolved);
}

export function resolveLocalDeviceWsUrl(): string {
  const activeWsUrl = resolveActiveWsUrl();
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
  return activeWsUrl;
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

export function connectToWsHost(
  _targetWsUrl: string,
  options?: { readonly path?: string; readonly reload?: boolean },
): void {
  if (typeof window === "undefined") {
    return;
  }
  const requestedPath = options?.path?.trim() ?? "";
  const nextUrl =
    requestedPath.length > 0
      ? requestedPath
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;
  clearActiveWsUrlOverride();
  if (options?.reload === false || requestedPath.length > 0) {
    window.history.pushState(window.history.state, "", nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  window.location.assign(nextUrl);
}

export async function verifyWsHostConnection(
  targetWsUrl: string,
  options?: { readonly timeoutMs?: number },
): Promise<void> {
  const normalizedTarget = normalizeWsUrl(targetWsUrl);
  if (parseRelayConnectionUrl(normalizedTarget)) {
    const transport = new RelayRpcTransport({
      connectionUrl: normalizedTarget,
      clientSessionId: createRelayProbeId("relay-probe"),
      connectionId: createRelayProbeId("relay-connection"),
      deviceName: "ace web",
      loadIdentity: loadWebRelayDeviceIdentity,
    });
    try {
      await Promise.race([
        transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => {
              reject(
                new Error(
                  `Connection check timed out after ${String(
                    Math.max(1_000, options?.timeoutMs ?? 5_000),
                  )}ms.`,
                ),
              );
            },
            Math.max(1_000, options?.timeoutMs ?? 5_000),
          );
        }),
      ]);
      return;
    } finally {
      await transport.dispose().catch(() => undefined);
    }
  }
  const { wsUrl, authToken } = splitWsUrlAuthToken(normalizedTarget);
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 5_000);
  const probeErrors: string[] = [];

  try {
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
    return;
  } catch (error) {
    probeErrors.push(error instanceof Error ? error.message : String(error));
  }

  if (typeof window !== "undefined" && typeof WebSocket === "function") {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let socket: WebSocket | null = null;
      let onOpen: (() => void) | null = null;
      let onError: (() => void) | null = null;
      let onClose: ((event: CloseEvent) => void) | null = null;

      const detachListeners = () => {
        if (!socket) {
          return;
        }
        if (onOpen) {
          socket.removeEventListener("open", onOpen);
        }
        if (onError) {
          socket.removeEventListener("error", onError);
        }
        if (onClose) {
          socket.removeEventListener("close", onClose);
        }
      };

      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
        detachListeners();
        handler();
      };

      timeoutHandle = setTimeout(() => {
        finish(() => {
          reject(new Error(`Connection check timed out after ${String(timeoutMs)}ms.`));
        });
      }, timeoutMs);

      try {
        socket = new WebSocket(normalizedTarget);
      } catch (error) {
        finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      onOpen = () => {
        opened = true;
        finish(() => {
          try {
            socket?.close(1_000, "probe-complete");
          } catch {
            // Ignore close failures in probe flow.
          }
          resolve();
        });
      };
      socket.addEventListener("open", onOpen);

      onError = () => {
        finish(() => {
          reject(new Error(`Unable to establish a WebSocket connection to ${normalizedTarget}.`));
        });
      };
      socket.addEventListener("error", onError);

      onClose = (event) => {
        if (opened) {
          return;
        }
        finish(() => {
          reject(new Error(`WebSocket closed before opening (code ${String(event.code)}).`));
        });
      };
      socket.addEventListener("close", onClose);
    })
      .then(() => undefined)
      .catch((error) => {
        probeErrors.push(error instanceof Error ? error.message : String(error));
      });
    if (probeErrors.length === 1) {
      // Socket probe succeeded.
      return;
    }
  }

  throw new Error(probeErrors.filter((message) => message.trim().length > 0).join(" "));
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
    relayUrl?: unknown;
    hostDeviceId?: unknown;
    viewerDeviceId?: unknown;
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
    ...(typeof value.relayUrl === "string" ? { relayUrl: value.relayUrl } : {}),
    ...(typeof value.hostDeviceId === "string" ? { hostDeviceId: value.hostDeviceId } : {}),
    ...(typeof value.viewerDeviceId === "string" ? { viewerDeviceId: value.viewerDeviceId } : {}),
  };
}

function assertPairingSessionSummary(payload: unknown): HostPairingSessionSummary {
  const status = assertPairingSessionStatus(payload);
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Pairing session response was invalid.");
  }
  const value = payload as {
    name?: unknown;
    createdAt?: unknown;
    resolvedAt?: unknown;
  };
  if (typeof value.name !== "string" || typeof value.createdAt !== "string") {
    throw new Error("Pairing session response was missing required fields.");
  }
  return {
    ...status,
    name: value.name,
    createdAt: value.createdAt,
    ...(typeof value.resolvedAt === "string" ? { resolvedAt: value.resolvedAt } : {}),
  };
}

function assertPairingSessionSummaryList(
  payload: unknown,
): ReadonlyArray<HostPairingSessionSummary> {
  if (!Array.isArray(payload)) {
    throw new Error("Pairing sessions response was invalid.");
  }
  return payload.map((entry) => assertPairingSessionSummary(entry));
}

function assertPairingSessionCreated(payload: unknown): HostPairingSessionCreated {
  const status = assertPairingSessionStatus(payload);
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Pairing session response was invalid.");
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
    throw new Error("Pairing session creation response was missing required fields.");
  }
  const claimUrl = typeof value.claimUrl === "string" ? value.claimUrl : undefined;
  const pollingUrl = typeof value.pollingUrl === "string" ? value.pollingUrl : undefined;
  const relayUrl = typeof value.relayUrl === "string" ? value.relayUrl : undefined;
  const hostDeviceId = typeof value.hostDeviceId === "string" ? value.hostDeviceId : undefined;
  const hostIdentityPublicKey =
    typeof value.hostIdentityPublicKey === "string" ? value.hostIdentityPublicKey : undefined;
  if (!claimUrl && !pollingUrl && (!relayUrl || !hostDeviceId || !hostIdentityPublicKey)) {
    throw new Error("Pairing session creation response did not include a polling endpoint.");
  }
  return {
    ...status,
    secret: value.secret,
    ...(claimUrl ? { claimUrl } : {}),
    ...(pollingUrl ? { pollingUrl } : {}),
    ...(relayUrl ? { relayUrl } : {}),
    ...(hostDeviceId ? { hostDeviceId } : {}),
    ...(hostIdentityPublicKey ? { hostIdentityPublicKey } : {}),
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
  const payload = buildPairingPayload(pairing);
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
  if (pairing.relayUrl && pairing.hostDeviceId && pairing.hostIdentityPublicKey) {
    return buildRelayHostConnectionDraft({
      pairing,
      viewerIdentity: await loadWebRelayDeviceIdentity(),
    });
  }
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

export async function listHostPairingSessions(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
}): Promise<ReadonlyArray<HostPairingSessionSummary>> {
  const payload = await requestPairingSessionJson(
    {
      wsUrl: input.wsUrl,
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
    {
      method: "GET",
      path: "/api/pairing/sessions",
    },
  );
  return assertPairingSessionSummaryList(payload);
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

export async function revokeHostPairingSession(input: {
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
      method: "POST",
      path: `/api/pairing/sessions/${encodeURIComponent(input.sessionId)}/revoke`,
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
