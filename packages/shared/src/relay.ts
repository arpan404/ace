import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";

export const RELAY_CONNECTION_QUERY_PARAM = "aceRelay";
export const DEFAULT_RELAY_WS_PATH = "/v1/ws";
export const MAX_HOST_RELAY_URLS = 3;
export const RELAY_KEY_BYTES = 32;
export const RELAY_NONCE_BYTES = 24;
export const RELAY_PREVIOUS_EPOCH_OVERLAP_FRAMES = 32;
export const RELAY_REKEY_AFTER_BYTES = 64 * 1024 * 1024;
export const RELAY_REKEY_AFTER_ACTIVE_MS = 10 * 60_000;

export interface RelayConnectionMetadata {
  readonly version: 1;
  readonly relayUrl: string;
  readonly hostDeviceId: string;
  readonly hostIdentityPublicKey: string;
  readonly pairingId: string;
  readonly pairingSecret: string;
  readonly hostName?: string;
  readonly expiresAt?: string;
}

export interface RelayStoredKeyPair {
  readonly secretKey: string;
  readonly publicKey: string;
}

export interface RelayStoredDeviceIdentity extends RelayStoredKeyPair {
  readonly deviceId: string;
  readonly createdAt: string;
}

export interface RelayRouteKeyMaterial {
  readonly viewerToHostKey: Uint8Array;
  readonly hostToViewerKey: Uint8Array;
  readonly exporterKey: Uint8Array;
}

export interface RelayRouteSessionKeys {
  readonly sendKey: Uint8Array;
  readonly receiveKey: Uint8Array;
  readonly exporterKey: Uint8Array;
}

export interface RelayEncryptedPayload {
  readonly nonce: string;
  readonly ciphertext: string;
}

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function ensureRelayPath(pathname: string): string {
  if (pathname.trim().length === 0 || pathname === "/") {
    return DEFAULT_RELAY_WS_PATH;
  }
  return pathname;
}

interface Base64BufferLike {
  readonly from: (
    input: Uint8Array | string,
    encoding?: "base64",
  ) => ArrayLike<number> & {
    readonly toString: (encoding: "base64") => string;
  };
}

function createRelayRandomId(): string {
  const cryptoObject = globalThis.crypto as
    | {
        readonly randomUUID?: () => string;
      }
    | undefined;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[(.*)\]$/, "$1")
    .trim()
    .toLowerCase();
}

function encodeBase64UrlBytes(input: Uint8Array): string {
  const bufferCtor = (globalThis as { Buffer?: Base64BufferLike }).Buffer;
  const base64 = bufferCtor
    ? bufferCtor.from(input).toString("base64")
    : btoa(String.fromCharCode(...input));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bufferCtor = (globalThis as { Buffer?: Base64BufferLike }).Buffer;
  if (bufferCtor) {
    return new Uint8Array(bufferCtor.from(padded, "base64"));
  }
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64UrlUtf8(input: string): string {
  return encodeBase64UrlBytes(new TextEncoder().encode(input));
}

function decodeBase64UrlUtf8(input: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(input));
}

function isRfc1918Ipv4(hostname: string): boolean {
  const segments = hostname.split(".");
  if (segments.length !== 4 || segments.some((segment) => !/^\d+$/.test(segment))) {
    return false;
  }
  const [a, b] = segments.map((segment) => Number.parseInt(segment, 10));
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

export function isLocalRelayHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    LOCALHOST_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".local") ||
    isRfc1918Ipv4(normalized)
  );
}

export function normalizeRelayWebSocketUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Relay URL is required.");
  }

  if (
    trimmed.startsWith("ws://") ||
    trimmed.startsWith("wss://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    parsed.pathname = ensureRelayPath(parsed.pathname);
    return parsed.toString();
  }

  const hostLikePattern = /^[a-z0-9_.-]+(?::\d+)?$/i;
  if (hostLikePattern.test(trimmed)) {
    const parsed = new URL(`ws://${trimmed}`);
    parsed.pathname = DEFAULT_RELAY_WS_PATH;
    return parsed.toString();
  }

  throw new Error("Invalid relay URL. Use ws://, wss://, http://, https://, or host:port.");
}

export function validateRelayWebSocketUrl(
  input: string,
  options?: { readonly allowInsecureLocalUrls?: boolean },
): string {
  const normalized = normalizeRelayWebSocketUrl(input);
  const parsed = new URL(normalized);
  if (parsed.protocol === "wss:") {
    return normalized;
  }
  if (parsed.protocol !== "ws:") {
    throw new Error("Relay URL must use ws:// or wss:// after normalization.");
  }
  if (!options?.allowInsecureLocalUrls) {
    throw new Error("Insecure relay URLs require the local-insecure relay setting.");
  }
  if (!isLocalRelayHostname(parsed.hostname)) {
    throw new Error("Public relay URLs must use TLS (wss:// or https://).");
  }
  return normalized;
}

export function resolveConfiguredRelayWebSocketUrl(input?: {
  readonly explicitRelayUrl?: string;
  readonly envRelayUrl?: string;
  readonly persistedRelayUrl?: string;
  readonly allowInsecureLocalUrls?: boolean;
}): string {
  const candidate =
    input?.explicitRelayUrl?.trim() ||
    input?.envRelayUrl?.trim() ||
    input?.persistedRelayUrl?.trim() ||
    DEFAULT_MANAGED_RELAY_URL;
  return validateRelayWebSocketUrl(candidate, {
    ...(input?.allowInsecureLocalUrls !== undefined
      ? { allowInsecureLocalUrls: input.allowInsecureLocalUrls }
      : {}),
  });
}

export function buildRelayConnectionUrl(metadata: RelayConnectionMetadata): string {
  const relayUrl = normalizeRelayWebSocketUrl(metadata.relayUrl);
  const encoded = encodeBase64UrlUtf8(
    JSON.stringify({
      version: 1,
      relayUrl,
      hostDeviceId: metadata.hostDeviceId,
      hostIdentityPublicKey: metadata.hostIdentityPublicKey,
      pairingId: metadata.pairingId,
      pairingSecret: metadata.pairingSecret,
      ...(metadata.hostName ? { hostName: metadata.hostName } : {}),
      ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
    } satisfies RelayConnectionMetadata),
  );
  const parsed = new URL(relayUrl);
  parsed.searchParams.set(RELAY_CONNECTION_QUERY_PARAM, encoded);
  return parsed.toString();
}

export function parseRelayConnectionUrl(input: string): RelayConnectionMetadata | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const encoded = parsed.searchParams.get(RELAY_CONNECTION_QUERY_PARAM);
  if (!encoded) {
    return null;
  }
  try {
    const decoded = JSON.parse(decodeBase64UrlUtf8(encoded)) as Partial<RelayConnectionMetadata>;
    if (
      decoded.version !== 1 ||
      typeof decoded.relayUrl !== "string" ||
      typeof decoded.hostDeviceId !== "string" ||
      typeof decoded.hostIdentityPublicKey !== "string" ||
      typeof decoded.pairingId !== "string" ||
      typeof decoded.pairingSecret !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      relayUrl: normalizeRelayWebSocketUrl(decoded.relayUrl),
      hostDeviceId: decoded.hostDeviceId,
      hostIdentityPublicKey: decoded.hostIdentityPublicKey,
      pairingId: decoded.pairingId,
      pairingSecret: decoded.pairingSecret,
      ...(typeof decoded.hostName === "string" ? { hostName: decoded.hostName } : {}),
      ...(typeof decoded.expiresAt === "string" ? { expiresAt: decoded.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

export function resolveActiveRelayUrls(input: {
  readonly defaultRelayUrl?: string;
  readonly pinnedRelayUrls?: ReadonlyArray<string>;
  readonly allowInsecureLocalUrls?: boolean;
  readonly maxRelayUrls?: number;
}): ReadonlyArray<string> {
  const urls = new Set<string>();
  const allowInsecureLocalUrls = input.allowInsecureLocalUrls ?? false;
  const maxRelayUrls = input.maxRelayUrls ?? MAX_HOST_RELAY_URLS;
  const add = (value: string | undefined) => {
    if (!value) {
      return;
    }
    urls.add(validateRelayWebSocketUrl(value, { allowInsecureLocalUrls }));
  };

  add(input.defaultRelayUrl ?? DEFAULT_MANAGED_RELAY_URL);
  for (const relayUrl of input.pinnedRelayUrls ?? []) {
    add(relayUrl);
  }

  const resolved = [...urls];
  if (resolved.length > maxRelayUrls) {
    throw new Error(
      `Relay registration limit exceeded (${String(resolved.length)}/${String(maxRelayUrls)}). Revoke or migrate older paired devices before adding another relay.`,
    );
  }
  return resolved;
}

export function createRelayDeviceIdentity(
  now = new Date().toISOString(),
): RelayStoredDeviceIdentity {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    deviceId: createRelayRandomId(),
    createdAt: now,
    secretKey: encodeBase64UrlBytes(secretKey),
    publicKey: encodeBase64UrlBytes(publicKey),
  };
}

export function createRelayEphemeralKeyPair(): RelayStoredKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    secretKey: encodeBase64UrlBytes(secretKey),
    publicKey: encodeBase64UrlBytes(publicKey),
  };
}

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function routeContextBytes(input: {
  readonly relayUrl: string;
  readonly routeId: string;
  readonly hostDeviceId: string;
  readonly viewerDeviceId: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      "ace-relay-v1",
      normalizeRelayWebSocketUrl(input.relayUrl),
      input.routeId,
      input.hostDeviceId,
      input.viewerDeviceId,
    ].join("\u0000"),
  );
}

export function deriveRelayRouteKeys(input: {
  readonly relayUrl: string;
  readonly routeId: string;
  readonly hostDeviceId: string;
  readonly viewerDeviceId: string;
  readonly localRole: "host" | "viewer";
  readonly localStaticSecretKey: string;
  readonly localEphemeralSecretKey: string;
  readonly remoteStaticPublicKey: string;
  readonly remoteEphemeralPublicKey: string;
  readonly localHandshakeNonce: string;
  readonly remoteHandshakeNonce: string;
}): RelayRouteSessionKeys {
  const dh1 = x25519.getSharedSecret(
    decodeBase64UrlBytes(input.localStaticSecretKey),
    decodeBase64UrlBytes(input.remoteEphemeralPublicKey),
  );
  const dh2 = x25519.getSharedSecret(
    decodeBase64UrlBytes(input.localEphemeralSecretKey),
    decodeBase64UrlBytes(input.remoteStaticPublicKey),
  );
  const dh3 = x25519.getSharedSecret(
    decodeBase64UrlBytes(input.localEphemeralSecretKey),
    decodeBase64UrlBytes(input.remoteEphemeralPublicKey),
  );

  const ikm = concatBytes(dh1, dh2, dh3);
  const salt = concatBytes(
    routeContextBytes(input),
    decodeBase64UrlBytes(input.localHandshakeNonce),
    decodeBase64UrlBytes(input.remoteHandshakeNonce),
  );
  const info = new TextEncoder().encode("ace relay session keys");
  const keyMaterial = hkdf(blake2s, ikm, salt, info, RELAY_KEY_BYTES * 3);
  const viewerToHostKey = keyMaterial.subarray(0, RELAY_KEY_BYTES);
  const hostToViewerKey = keyMaterial.subarray(RELAY_KEY_BYTES, RELAY_KEY_BYTES * 2);
  const exporterKey = keyMaterial.subarray(RELAY_KEY_BYTES * 2, RELAY_KEY_BYTES * 3);

  return input.localRole === "viewer"
    ? {
        sendKey: viewerToHostKey,
        receiveKey: hostToViewerKey,
        exporterKey,
      }
    : {
        sendKey: hostToViewerKey,
        receiveKey: viewerToHostKey,
        exporterKey,
      };
}

export function createRelayHandshakeNonce(): string {
  return encodeBase64UrlBytes(randomBytes(32));
}

export function encryptRelayFrame(input: {
  readonly key: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly associatedData: Uint8Array;
}): RelayEncryptedPayload {
  const nonce = randomBytes(RELAY_NONCE_BYTES);
  const cipher = xchacha20poly1305(input.key, nonce, input.associatedData);
  return {
    nonce: encodeBase64UrlBytes(nonce),
    ciphertext: encodeBase64UrlBytes(cipher.encrypt(input.plaintext)),
  };
}

export function decryptRelayFrame(input: {
  readonly key: Uint8Array;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly associatedData: Uint8Array;
}): Uint8Array {
  const cipher = xchacha20poly1305(
    input.key,
    decodeBase64UrlBytes(input.nonce),
    input.associatedData,
  );
  return cipher.decrypt(decodeBase64UrlBytes(input.ciphertext));
}

export function deriveNextRelayEpochKey(input: {
  readonly currentKey: Uint8Array;
  readonly exporterKey: Uint8Array;
  readonly epoch: number;
  readonly direction: "send" | "receive";
}): Uint8Array {
  return hkdf(
    blake2s,
    input.currentKey,
    input.exporterKey,
    new TextEncoder().encode(
      `ace relay rekey v1\u0000${input.direction}\u0000${String(input.epoch + 1)}`,
    ),
    RELAY_KEY_BYTES,
  );
}

export function buildRelayFrameAssociatedData(input: {
  readonly routeId: string;
  readonly direction: "viewer_to_host" | "host_to_viewer";
  readonly keyEpoch: number;
  readonly sequence: number;
  readonly frameKind: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      "ace-relay-frame-v1",
      input.routeId,
      input.direction,
      String(input.keyEpoch),
      String(input.sequence),
      input.frameKind,
    ].join("\u0000"),
  );
}

export function encodeRelayJson(input: unknown): string {
  return JSON.stringify(input);
}

export function decodeRelayJson<TValue>(input: string): TValue {
  return JSON.parse(input) as TValue;
}
