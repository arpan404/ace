import {
  buildRelayConnectionUrl,
  deriveRelayPairingAuthKey,
  normalizeRelayWebSocketUrl,
  parseRelayConnectionUrl,
  type RelayStoredDeviceIdentity,
} from "./relay";

export interface HostConnectionDraft {
  readonly name?: string;
  readonly wsUrl: string;
  readonly authToken?: string;
}

export interface HostPairingPayload {
  readonly name?: string;
  readonly wsUrl?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
  readonly sessionId: string;
  readonly secret: string;
  readonly claimUrl?: string;
  readonly pollingUrl?: string;
  readonly expiresAt?: string;
}

export interface HostConnectionDescriptor {
  readonly kind: "direct" | "relay";
  readonly connectionUrl: string;
  readonly endpointUrl: string;
  readonly summary: string;
  readonly detail: string;
  readonly selectorValues: ReadonlyArray<string>;
  readonly relayUrl?: string;
  readonly relayHost?: string;
  readonly hostDeviceId?: string;
}

export type HostConnectionQrPayload =
  | {
      readonly kind: "direct";
      readonly draft: HostConnectionDraft;
    }
  | {
      readonly kind: "pairing";
      readonly pairing: HostPairingPayload;
    };

interface QrHostPayload {
  readonly name?: string;
  readonly wsUrl?: string;
  readonly url?: string;
  readonly ws?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
  readonly expiresAt?: string;
  readonly authToken?: string;
  readonly token?: string;
  readonly sessionId?: string;
  readonly pairingId?: string;
  readonly secret?: string;
  readonly pairingSecret?: string;
  readonly claimUrl?: string;
  readonly pairingUrl?: string;
  readonly pollingUrl?: string;
}

function ensureWsPath(pathname: string): string {
  if (pathname.trim().length === 0 || pathname === "/") {
    return "/ws";
  }
  return pathname;
}

export function normalizeWsUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Host URL is required.");
  }

  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    const parsed = new URL(trimmed);
    parsed.pathname = ensureWsPath(parsed.pathname);
    return parsed.toString();
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = ensureWsPath(parsed.pathname);
    return parsed.toString();
  }

  const hostLikePattern = /^[a-z0-9_.-]+(?::\d+)?$/i;
  if (hostLikePattern.test(trimmed)) {
    const parsed = new URL(`ws://${trimmed}`);
    parsed.pathname = "/ws";
    return parsed.toString();
  }

  throw new Error("Invalid host URL. Use ws://, wss://, http://, https://, or host:port.");
}

function parseAceSchemePayload(rawPayload: string): QrHostPayload | null {
  if (!rawPayload.startsWith("ace://")) {
    return null;
  }
  try {
    const parsed = new URL(rawPayload);
    const wsUrl = parsed.searchParams.get("wsUrl") ?? parsed.searchParams.get("ws");
    const url = parsed.searchParams.get("url");
    const token = parsed.searchParams.get("token");
    const name = parsed.searchParams.get("name");
    const encodedPairing = parsed.searchParams.get("p");
    const sessionId = parsed.searchParams.get("sessionId") ?? parsed.searchParams.get("pairingId");
    const secret = parsed.searchParams.get("secret") ?? parsed.searchParams.get("pairingSecret");
    const claimUrl = parsed.searchParams.get("claimUrl") ?? parsed.searchParams.get("pairingUrl");
    const decodedPairingPayload = decodeEncodedPairingPayload(encodedPairing);
    return {
      ...(name ? { name } : {}),
      ...(wsUrl ? { wsUrl } : {}),
      ...(url ? { url } : {}),
      ...(token ? { token } : {}),
      ...(decodedPairingPayload?.name ? { name: decodedPairingPayload.name } : {}),
      ...(decodedPairingPayload?.wsUrl ? { wsUrl: decodedPairingPayload.wsUrl } : {}),
      ...(decodedPairingPayload?.relayUrl ? { relayUrl: decodedPairingPayload.relayUrl } : {}),
      ...(decodedPairingPayload?.hostDeviceId
        ? { hostDeviceId: decodedPairingPayload.hostDeviceId }
        : {}),
      ...(decodedPairingPayload?.hostIdentityPublicKey
        ? { hostIdentityPublicKey: decodedPairingPayload.hostIdentityPublicKey }
        : {}),
      ...(decodedPairingPayload?.sessionId ? { sessionId: decodedPairingPayload.sessionId } : {}),
      ...(decodedPairingPayload?.secret ? { secret: decodedPairingPayload.secret } : {}),
      ...(decodedPairingPayload?.claimUrl ? { claimUrl: decodedPairingPayload.claimUrl } : {}),
      ...(decodedPairingPayload?.expiresAt ? { expiresAt: decodedPairingPayload.expiresAt } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      ...(claimUrl ? { claimUrl } : {}),
    };
  } catch {
    return null;
  }
}

function decodeBase64UrlUtf8(input: string): string | null {
  const normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length === 0) {
    return null;
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary =
      typeof atob === "function"
        ? atob(padded)
        : (
            globalThis as {
              Buffer?: {
                from: (
                  value: string,
                  encoding: string,
                ) => { toString: (encoding: string) => string };
              };
            }
          ).Buffer?.from(padded, "base64")?.toString("binary");
    if (!binary) {
      return null;
    }
    const percentEncoded = Array.from(
      binary,
      (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ).join("");
    return decodeURIComponent(percentEncoded);
  } catch {
    return null;
  }
}

function decodeEncodedPairingPayload(encodedPayload: string | null): {
  readonly name?: string;
  readonly wsUrl?: string;
  readonly relayUrl?: string;
  readonly hostDeviceId?: string;
  readonly hostIdentityPublicKey?: string;
  readonly sessionId?: string;
  readonly secret?: string;
  readonly claimUrl?: string;
  readonly expiresAt?: string;
} | null {
  if (!encodedPayload) {
    return null;
  }
  const decodedText = decodeBase64UrlUtf8(encodedPayload);
  if (!decodedText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedText) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = parsed as {
    readonly name?: unknown;
    readonly wsUrl?: unknown;
    readonly relayUrl?: unknown;
    readonly hostDeviceId?: unknown;
    readonly hostIdentityPublicKey?: unknown;
    readonly sessionId?: unknown;
    readonly secret?: unknown;
    readonly claimUrl?: unknown;
    readonly expiresAt?: unknown;
  };
  return {
    ...(typeof value.name === "string" && value.name.trim().length > 0
      ? { name: value.name.trim() }
      : {}),
    ...(typeof value.wsUrl === "string" && value.wsUrl.trim().length > 0
      ? { wsUrl: value.wsUrl.trim() }
      : {}),
    ...(typeof value.relayUrl === "string" && value.relayUrl.trim().length > 0
      ? { relayUrl: value.relayUrl.trim() }
      : {}),
    ...(typeof value.hostDeviceId === "string" && value.hostDeviceId.trim().length > 0
      ? { hostDeviceId: value.hostDeviceId.trim() }
      : {}),
    ...(typeof value.hostIdentityPublicKey === "string" &&
    value.hostIdentityPublicKey.trim().length > 0
      ? { hostIdentityPublicKey: value.hostIdentityPublicKey.trim() }
      : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.secret === "string" ? { secret: value.secret } : {}),
    ...(typeof value.claimUrl === "string" ? { claimUrl: value.claimUrl } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

function resolveDraftFromPayload(payload: QrHostPayload): HostConnectionDraft | null {
  const urlValue = payload.wsUrl ?? payload.ws ?? payload.url;
  if (!urlValue || typeof urlValue !== "string") {
    return null;
  }
  return {
    wsUrl: urlValue,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.authToken === "string"
      ? { authToken: payload.authToken }
      : typeof payload.token === "string"
        ? { authToken: payload.token }
        : {}),
  };
}

function resolvePairingClaimUrl(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolvePairingFromPayload(payload: QrHostPayload): HostPairingPayload | null {
  const sessionId = payload.sessionId ?? payload.pairingId;
  const secret = payload.secret ?? payload.pairingSecret;
  if (typeof sessionId !== "string" || typeof secret !== "string") {
    return null;
  }
  const trimmedSessionId = sessionId.trim();
  const trimmedSecret = secret.trim();
  if (trimmedSessionId.length === 0 || trimmedSecret.length === 0) {
    return null;
  }
  if (
    typeof payload.relayUrl === "string" &&
    payload.relayUrl.trim().length > 0 &&
    typeof payload.hostDeviceId === "string" &&
    payload.hostDeviceId.trim().length > 0 &&
    typeof payload.hostIdentityPublicKey === "string" &&
    payload.hostIdentityPublicKey.trim().length > 0
  ) {
    return {
      ...(typeof payload.name === "string" && payload.name.trim().length > 0
        ? { name: payload.name.trim() }
        : {}),
      relayUrl: normalizeRelayWebSocketUrl(payload.relayUrl),
      hostDeviceId: payload.hostDeviceId.trim(),
      hostIdentityPublicKey: payload.hostIdentityPublicKey.trim(),
      sessionId: trimmedSessionId,
      secret: trimmedSecret,
      ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {}),
    };
  }
  const wsUrl = payload.wsUrl ?? payload.url ?? payload.ws;
  if (typeof wsUrl !== "string" || wsUrl.trim().length === 0) {
    return null;
  }
  const claimUrl = payload.claimUrl ?? payload.pairingUrl;
  const pollingUrl = payload.pollingUrl;
  if (typeof claimUrl === "string") {
    const normalizedClaimUrl = resolvePairingClaimUrl(claimUrl.trim());
    if (!normalizedClaimUrl) {
      return null;
    }
    return {
      ...(typeof payload.name === "string" && payload.name.trim().length > 0
        ? { name: payload.name.trim() }
        : {}),
      wsUrl: wsUrl.trim(),
      sessionId: trimmedSessionId,
      secret: trimmedSecret,
      claimUrl: normalizedClaimUrl,
    };
  }
  if (typeof pollingUrl === "string" && pollingUrl.trim().length > 0) {
    return {
      ...(typeof payload.name === "string" && payload.name.trim().length > 0
        ? { name: payload.name.trim() }
        : {}),
      wsUrl: wsUrl.trim(),
      sessionId: trimmedSessionId,
      secret: trimmedSecret,
      pollingUrl: pollingUrl.trim(),
    };
  }
  return null;
}

export function parseHostConnectionQrPayload(rawPayload: string): HostConnectionQrPayload | null {
  const trimmed = rawPayload.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (
    trimmed.startsWith("ws://") ||
    trimmed.startsWith("wss://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return {
      kind: "direct",
      draft: { wsUrl: trimmed },
    };
  }

  const fromAceScheme = parseAceSchemePayload(trimmed);
  if (fromAceScheme) {
    const pairing = resolvePairingFromPayload(fromAceScheme);
    if (pairing) {
      return { kind: "pairing", pairing };
    }
    const draft = resolveDraftFromPayload(fromAceScheme);
    if (draft) {
      return { kind: "direct", draft };
    }
    return null;
  }

  const hostLikePattern = /^[a-z0-9_.-]+(?::\d+)?$/i;
  if (hostLikePattern.test(trimmed)) {
    return {
      kind: "direct",
      draft: { wsUrl: trimmed },
    };
  }

  return null;
}

export function parseHostDraftFromQrPayload(rawPayload: string): HostConnectionDraft | null {
  const parsed = parseHostConnectionQrPayload(rawPayload);
  if (!parsed || parsed.kind !== "direct") {
    return null;
  }
  return parsed.draft;
}

export function buildPairingPayload(input: HostPairingPayload): string {
  const sessionId = input.sessionId.trim();
  const secret = input.secret.trim();
  if (sessionId.length === 0 || secret.length === 0) {
    throw new Error("Pairing session ID and secret are required.");
  }
  const name = input.name?.trim() ?? "";
  if (
    typeof input.relayUrl === "string" &&
    input.relayUrl.trim().length > 0 &&
    typeof input.hostDeviceId === "string" &&
    input.hostDeviceId.trim().length > 0 &&
    typeof input.hostIdentityPublicKey === "string" &&
    input.hostIdentityPublicKey.trim().length > 0
  ) {
    return JSON.stringify(
      {
        ...(name.length > 0 ? { name } : {}),
        relayUrl: normalizeRelayWebSocketUrl(input.relayUrl),
        hostDeviceId: input.hostDeviceId.trim(),
        hostIdentityPublicKey: input.hostIdentityPublicKey.trim(),
        sessionId,
        secret,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
      null,
      2,
    );
  }
  const claimUrl = input.claimUrl ? resolvePairingClaimUrl(input.claimUrl) : null;
  if (!claimUrl) {
    throw new Error("Pairing claim URL must use http:// or https://.");
  }
  const wsUrl = input.wsUrl?.trim() ?? "";
  if (wsUrl.length === 0) {
    throw new Error("Pairing host URL is required.");
  }
  return JSON.stringify(
    {
      ...(name.length > 0 ? { name } : {}),
      wsUrl,
      sessionId,
      secret,
      claimUrl,
    },
    null,
    2,
  );
}

export function buildRelayHostConnectionDraft(input: {
  readonly pairing: HostPairingPayload;
  readonly viewerIdentity: Pick<RelayStoredDeviceIdentity, "deviceId" | "publicKey">;
}): HostConnectionDraft {
  const { pairing, viewerIdentity } = input;
  if (!pairing.relayUrl || !pairing.hostDeviceId || !pairing.hostIdentityPublicKey) {
    throw new Error("Relay pairing payload is missing relay metadata.");
  }
  const pairingAuthKey = deriveRelayPairingAuthKey({
    pairingId: pairing.sessionId,
    pairingSecret: pairing.secret,
    hostDeviceId: pairing.hostDeviceId,
    hostIdentityPublicKey: pairing.hostIdentityPublicKey,
    viewerDeviceId: viewerIdentity.deviceId,
    viewerIdentityPublicKey: viewerIdentity.publicKey,
  });
  return {
    ...(pairing.name?.trim() ? { name: pairing.name.trim() } : {}),
    wsUrl: buildRelayConnectionUrl({
      version: 1,
      relayUrl: pairing.relayUrl,
      hostDeviceId: pairing.hostDeviceId,
      hostIdentityPublicKey: pairing.hostIdentityPublicKey,
      pairingId: pairing.sessionId,
      pairingAuthKey,
      ...(pairing.name?.trim() ? { hostName: pairing.name.trim() } : {}),
      ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
    }),
  };
}

export function resolveHostDisplayName(rawName: string | undefined, wsUrl: string): string {
  const trimmed = rawName?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  const relayMetadata = parseRelayConnectionUrl(wsUrl);
  if (relayMetadata) {
    const preferredName =
      relayMetadata.hostName?.trim() || relayMetadata.hostDeviceId.trim() || relayMetadata.relayUrl;
    return `ace @ ${preferredName}`;
  }

  const parsed = new URL(wsUrl);
  return `ace @ ${parsed.host}`;
}

export function splitWsUrlAuthToken(wsUrl: string): {
  readonly wsUrl: string;
  readonly authToken: string;
} {
  const parsed = new URL(normalizeWsUrl(wsUrl));
  const authToken = parsed.searchParams.get("token")?.trim() ?? "";
  if (authToken.length > 0) {
    parsed.searchParams.delete("token");
  }
  return {
    wsUrl: parsed.toString(),
    authToken,
  };
}

export function appendWsAuthToken(wsUrl: string, authToken: string | undefined): string {
  const parsed = new URL(normalizeWsUrl(wsUrl));
  const trimmedToken = authToken?.trim() ?? "";
  if (trimmedToken.length === 0) {
    parsed.searchParams.delete("token");
  } else {
    parsed.searchParams.set("token", trimmedToken);
  }
  return parsed.toString();
}

function compactSelectorValues(values: ReadonlyArray<string | undefined>): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      deduped.add(trimmed);
      deduped.add(trimmed.toLowerCase());
    }
  }
  return [...deduped];
}

export function describeHostConnection(input: {
  readonly wsUrl: string;
  readonly authToken?: string;
}): HostConnectionDescriptor {
  const connectionUrl = appendWsAuthToken(input.wsUrl, input.authToken);
  const relayMetadata = parseRelayConnectionUrl(connectionUrl);
  if (relayMetadata) {
    const relayParsed = new URL(relayMetadata.relayUrl);
    const relayHost = relayParsed.host || relayParsed.hostname;
    const detail = `Host ${relayMetadata.hostDeviceId}`;
    return {
      kind: "relay",
      connectionUrl,
      endpointUrl: relayMetadata.relayUrl,
      summary: `Relay via ${relayHost}`,
      detail,
      selectorValues: compactSelectorValues([
        connectionUrl,
        relayMetadata.relayUrl,
        relayHost,
        relayMetadata.hostDeviceId,
        relayMetadata.hostName,
      ]),
      relayUrl: relayMetadata.relayUrl,
      relayHost,
      hostDeviceId: relayMetadata.hostDeviceId,
    };
  }

  const normalizedWsUrl = normalizeWsUrl(input.wsUrl);
  const parsed = new URL(normalizedWsUrl);
  return {
    kind: "direct",
    connectionUrl,
    endpointUrl: normalizedWsUrl,
    summary: normalizedWsUrl,
    detail: parsed.host,
    selectorValues: compactSelectorValues([connectionUrl, normalizedWsUrl, parsed.host]),
  };
}

export function wsUrlToBrowserBaseUrl(wsUrl: string): string {
  const parsed = new URL(normalizeWsUrl(wsUrl));
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

type FetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

const DEFAULT_PAIRING_REQUEST_TIMEOUT_MS = 10_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorMessage(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }
  const errorValue = payload.error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue.trim();
  }
  return null;
}

async function parseResponseJson(response: FetchResponseLike): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Pairing server returned malformed JSON.");
  }
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl) {
    return fetchImpl;
  }
  if (typeof fetch !== "function") {
    throw new Error("Fetch API is unavailable in this runtime.");
  }
  return fetch as unknown as FetchLike;
}

function resolvePairingRequestTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(1_000, timeoutMs ?? DEFAULT_PAIRING_REQUEST_TIMEOUT_MS);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
  timeoutMs: number,
): Promise<FetchResponseLike> {
  const timeout = resolvePairingRequestTimeoutMs(timeoutMs);
  const hasAbortController = typeof AbortController !== "undefined";
  const controller = hasAbortController ? new AbortController() : null;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    controller?.abort();
  };
  if (isAbortSignal(init.signal)) {
    init.signal.addEventListener("abort", onAbort);
    if (init.signal.aborted) {
      onAbort();
    }
  }
  try {
    if (controller) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
    }
    return await fetchImpl(input, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new Error("Pairing request timed out. Check your network and host address.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (isAbortSignal(init.signal)) {
      init.signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface PairingClaimReceipt {
  readonly claimId: string;
  readonly pollUrl: string;
  readonly expiresAt: string;
  readonly sessionId?: string;
  readonly secret?: string;
  readonly sessionPollingUrl?: string;
}

export type PairingClaimResult =
  | {
      readonly status: "pending";
      readonly claimId: string;
      readonly expiresAt: string;
      readonly requesterName?: string;
    }
  | {
      readonly status: "approved";
      readonly claimId: string;
      readonly host: {
        readonly name: string;
        readonly wsUrl: string;
        readonly authToken: string;
      };
    }
  | {
      readonly status: "rejected" | "expired";
      readonly claimId: string;
    };

export async function requestPairingClaim(
  pairing: HostPairingPayload,
  options?: {
    readonly requesterName?: string;
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PairingClaimReceipt> {
  if (pairing.pollingUrl) {
    const receipt = await requestPairingClaimViaPolling(pairing, options);
    return receipt;
  }
  const claimUrl = pairing.claimUrl ? resolvePairingClaimUrl(pairing.claimUrl) : null;
  if (!claimUrl) {
    throw new Error("Pairing claim URL must use http:// or https://.");
  }
  const fetchImpl = resolveFetch(options?.fetch);
  const response = await fetchWithTimeout(
    fetchImpl,
    claimUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: pairing.sessionId,
        secret: pairing.secret,
        ...(options?.requesterName?.trim()
          ? {
              requesterName: options.requesterName.trim(),
            }
          : {}),
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    },
    options?.requestTimeoutMs ?? DEFAULT_PAIRING_REQUEST_TIMEOUT_MS,
  );
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readErrorMessage(payload);
    throw new Error(
      errorMessage ?? `Pairing claim request failed with status ${String(response.status)}.`,
    );
  }
  if (!isObjectRecord(payload)) {
    throw new Error("Pairing claim response was invalid.");
  }
  if (
    typeof payload.claimId !== "string" ||
    typeof payload.pollUrl !== "string" ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new Error("Pairing claim response was missing required fields.");
  }
  return {
    claimId: payload.claimId,
    pollUrl: payload.pollUrl,
    expiresAt: payload.expiresAt,
  };
}

async function requestPairingClaimViaPolling(
  pairing: HostPairingPayload,
  options?: {
    readonly requesterName?: string;
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PairingClaimReceipt> {
  const pollingUrl = pairing.pollingUrl ?? "";
  const fetchImpl = resolveFetch(options?.fetch);
  const resolveUrl = new URL(pollingUrl);
  resolveUrl.searchParams.set("sessionId", pairing.sessionId);
  resolveUrl.searchParams.set("secret", pairing.secret);
  if (options?.requesterName?.trim()) {
    resolveUrl.searchParams.set("requesterName", options.requesterName.trim());
  }
  const response = await fetchWithTimeout(
    fetchImpl,
    resolveUrl.toString(),
    {
      method: "POST",
      ...(options?.signal ? { signal: options.signal } : {}),
    },
    options?.requestTimeoutMs ?? DEFAULT_PAIRING_REQUEST_TIMEOUT_MS,
  );
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readErrorMessage(payload);
    throw new Error(
      errorMessage ?? `Pairing claim request failed with status ${String(response.status)}.`,
    );
  }
  if (!isObjectRecord(payload)) {
    throw new Error("Pairing claim response was invalid.");
  }
  if (typeof payload.status !== "string" || typeof payload.sessionId !== "string") {
    throw new Error("Pairing claim response was missing required fields.");
  }
  return {
    claimId: "",
    pollUrl: "",
    expiresAt: "",
    sessionId: pairing.sessionId,
    secret: pairing.secret,
    sessionPollingUrl: pollingUrl,
  };
}

export async function readPairingClaim(
  pollUrl: string,
  options?: {
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PairingClaimResult> {
  const normalizedPollUrl = resolvePairingClaimUrl(pollUrl);
  if (!normalizedPollUrl) {
    throw new Error("Pairing poll URL must use http:// or https://.");
  }
  const fetchImpl = resolveFetch(options?.fetch);
  const requestInit = options?.signal ? { signal: options.signal } : undefined;
  const response = await fetchWithTimeout(
    fetchImpl,
    normalizedPollUrl,
    requestInit ?? {},
    options?.requestTimeoutMs ?? DEFAULT_PAIRING_REQUEST_TIMEOUT_MS,
  );
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readErrorMessage(payload);
    throw new Error(
      errorMessage ?? `Pairing status request failed with status ${String(response.status)}.`,
    );
  }
  if (!isObjectRecord(payload)) {
    throw new Error("Pairing status response was invalid.");
  }
  if (typeof payload.status !== "string" || typeof payload.claimId !== "string") {
    throw new Error("Pairing status response was missing required fields.");
  }
  if (payload.status === "pending") {
    if (typeof payload.expiresAt !== "string") {
      throw new Error("Pending pairing status is missing expiresAt.");
    }
    return {
      status: "pending",
      claimId: payload.claimId,
      expiresAt: payload.expiresAt,
    };
  }
  if (payload.status === "approved") {
    const host = payload.host;
    if (
      !isObjectRecord(host) ||
      typeof host.name !== "string" ||
      typeof host.wsUrl !== "string" ||
      typeof host.authToken !== "string"
    ) {
      throw new Error("Approved pairing status is missing host details.");
    }
    return {
      status: "approved",
      claimId: payload.claimId,
      host: {
        name: host.name,
        wsUrl: host.wsUrl,
        authToken: host.authToken,
      },
    };
  }
  if (payload.status === "rejected" || payload.status === "expired") {
    return {
      status: payload.status,
      claimId: payload.claimId,
    };
  }
  throw new Error("Unknown pairing claim status.");
}

export async function readPairingSessionStatus(
  pollingUrl: string,
  options?: {
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<PairingClaimResult> {
  const fetchImpl = resolveFetch(options?.fetch);
  const requestInit = options?.signal ? { signal: options.signal } : undefined;
  const response = await fetchWithTimeout(
    fetchImpl,
    pollingUrl,
    requestInit ?? {},
    options?.requestTimeoutMs ?? DEFAULT_PAIRING_REQUEST_TIMEOUT_MS,
  );
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readErrorMessage(payload);
    throw new Error(
      errorMessage ??
        `Pairing session status request failed with status ${String(response.status)}.`,
    );
  }
  if (!isObjectRecord(payload)) {
    throw new Error("Pairing session status response was invalid.");
  }
  if (typeof payload.status !== "string") {
    throw new Error("Pairing session status response was missing status field.");
  }
  if (payload.status === "claim-pending") {
    const requesterName = typeof payload.requesterName === "string" ? payload.requesterName : "";
    return {
      status: "pending",
      claimId: "",
      expiresAt: "",
      requesterName,
    };
  }
  if (payload.status === "ready") {
    const host = payload.host;
    if (
      !isObjectRecord(host) ||
      typeof host.name !== "string" ||
      typeof host.wsUrl !== "string" ||
      typeof host.authToken !== "string"
    ) {
      throw new Error("Ready pairing session status is missing host details.");
    }
    return {
      status: "approved",
      claimId: "",
      host: {
        name: host.name,
        wsUrl: host.wsUrl,
        authToken: host.authToken,
      },
    };
  }
  if (payload.status === "expired") {
    return {
      status: "expired",
      claimId: "",
    };
  }
  if (payload.status === "rejected") {
    return {
      status: "rejected",
      claimId: "",
    };
  }
  throw new Error("Unknown pairing session status.");
}

export async function waitForPairingApproval(
  receipt: PairingClaimReceipt,
  options?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<HostConnectionDraft> {
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 90_000);
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1_200);
  const timeoutAt = Date.now() + timeoutMs;
  if (receipt.sessionPollingUrl) {
    for (;;) {
      const status = await readPairingSessionStatus(receipt.sessionPollingUrl, options);
      if (status.status === "approved") {
        return {
          ...(status.host.name.trim().length > 0 ? { name: status.host.name } : {}),
          wsUrl: status.host.wsUrl,
          authToken: status.host.authToken,
        };
      }
      if (status.status === "rejected") {
        throw new Error("Pairing request was rejected by the host.");
      }
      if (status.status === "expired") {
        throw new Error("Pairing session expired before approval.");
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("Timed out waiting for pairing approval.");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
    }
  }
  for (;;) {
    const status = await readPairingClaim(receipt.pollUrl, options);
    if (status.status === "approved") {
      return {
        ...(status.host.name.trim().length > 0 ? { name: status.host.name } : {}),
        wsUrl: status.host.wsUrl,
        authToken: status.host.authToken,
      };
    }
    if (status.status === "rejected") {
      throw new Error("Pairing request was rejected by the host.");
    }
    if (status.status === "expired") {
      throw new Error("Pairing session expired before approval.");
    }
    if (Date.now() >= timeoutAt) {
      throw new Error("Timed out waiting for pairing approval.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}
