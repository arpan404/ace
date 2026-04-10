export interface HostConnectionDraft {
  readonly name?: string;
  readonly wsUrl: string;
  readonly authToken?: string;
}

export interface HostPairingPayload {
  readonly name?: string;
  readonly sessionId: string;
  readonly secret: string;
  readonly claimUrl: string;
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
  readonly authToken?: string;
  readonly token?: string;
  readonly sessionId?: string;
  readonly pairingId?: string;
  readonly secret?: string;
  readonly pairingSecret?: string;
  readonly claimUrl?: string;
  readonly pairingUrl?: string;
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

function parseHostPayloadJson(rawPayload: string): QrHostPayload | null {
  if (!rawPayload.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as QrHostPayload;
  } catch {
    return null;
  }
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
    const sessionId = parsed.searchParams.get("sessionId") ?? parsed.searchParams.get("pairingId");
    const secret = parsed.searchParams.get("secret") ?? parsed.searchParams.get("pairingSecret");
    const claimUrl = parsed.searchParams.get("claimUrl") ?? parsed.searchParams.get("pairingUrl");
    return {
      ...(name ? { name } : {}),
      ...(wsUrl ? { wsUrl } : {}),
      ...(url ? { url } : {}),
      ...(token ? { token } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      ...(claimUrl ? { claimUrl } : {}),
    };
  } catch {
    return null;
  }
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
  const claimUrl = payload.claimUrl ?? payload.pairingUrl;
  if (typeof sessionId !== "string" || typeof secret !== "string" || typeof claimUrl !== "string") {
    return null;
  }
  const normalizedClaimUrl = resolvePairingClaimUrl(claimUrl.trim());
  if (!normalizedClaimUrl) {
    return null;
  }
  const trimmedSessionId = sessionId.trim();
  const trimmedSecret = secret.trim();
  if (trimmedSessionId.length === 0 || trimmedSecret.length === 0) {
    return null;
  }
  return {
    ...(typeof payload.name === "string" && payload.name.trim().length > 0
      ? { name: payload.name.trim() }
      : {}),
    sessionId: trimmedSessionId,
    secret: trimmedSecret,
    claimUrl: normalizedClaimUrl,
  };
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

  const fromJson = parseHostPayloadJson(trimmed);
  if (fromJson) {
    const pairing = resolvePairingFromPayload(fromJson);
    if (pairing) {
      return { kind: "pairing", pairing };
    }
    const draft = resolveDraftFromPayload(fromJson);
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
  const claimUrl = resolvePairingClaimUrl(input.claimUrl);
  if (!claimUrl) {
    throw new Error("Pairing claim URL must use http:// or https://.");
  }
  const sessionId = input.sessionId.trim();
  const secret = input.secret.trim();
  if (sessionId.length === 0 || secret.length === 0) {
    throw new Error("Pairing session ID and secret are required.");
  }
  const name = input.name?.trim() ?? "";
  return JSON.stringify(
    {
      ...(name.length > 0 ? { name } : {}),
      sessionId,
      secret,
      claimUrl,
    },
    null,
    2,
  );
}

export function resolveHostDisplayName(rawName: string | undefined, wsUrl: string): string {
  const trimmed = rawName?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
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
  },
) => Promise<FetchResponseLike>;

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

export interface PairingClaimReceipt {
  readonly claimId: string;
  readonly pollUrl: string;
  readonly expiresAt: string;
}

export type PairingClaimResult =
  | {
      readonly status: "pending";
      readonly claimId: string;
      readonly expiresAt: string;
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
  },
): Promise<PairingClaimReceipt> {
  const claimUrl = resolvePairingClaimUrl(pairing.claimUrl);
  if (!claimUrl) {
    throw new Error("Pairing claim URL must use http:// or https://.");
  }
  const fetchImpl = resolveFetch(options?.fetch);
  const response = await fetchImpl(claimUrl, {
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
  });
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

export async function readPairingClaim(
  pollUrl: string,
  options?: { readonly fetch?: FetchLike },
): Promise<PairingClaimResult> {
  const normalizedPollUrl = resolvePairingClaimUrl(pollUrl);
  if (!normalizedPollUrl) {
    throw new Error("Pairing poll URL must use http:// or https://.");
  }
  const fetchImpl = resolveFetch(options?.fetch);
  const response = await fetchImpl(normalizedPollUrl);
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

export async function waitForPairingApproval(
  receipt: PairingClaimReceipt,
  options?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly fetch?: FetchLike;
  },
): Promise<HostConnectionDraft> {
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 90_000);
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1_200);
  const timeoutAt = Date.now() + timeoutMs;
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
