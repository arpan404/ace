import type { RawData } from "ws";

const pingBytes = 64;

/** A text frame that is exactly a `ping`: small, and only `{ "type": "ping" }`. */
export function isPing(data: RawData): boolean {
  if (Array.isArray(data) || data.byteLength > pingBytes) return false;
  const text = Buffer.isBuffer(data) ? data.toString() : Buffer.from(data).toString();
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      "type" in parsed &&
      parsed.type === "ping"
    );
  } catch {
    return false;
  }
}

/** Closes a peer or browser makes on purpose: going away, a normal close, or no status. */
const ordinary = new Set([1000, 1001, 1005]);

/** Which kind of client a socket belongs to, from its User-Agent alone. Never an identity. */
export type ClientAgent = "desktop" | "ios" | "android" | "browser" | "node" | "other";

export function clientAgent(userAgent: string | undefined): ClientAgent {
  if (!userAgent) return "node";
  if (/\bElectron\//.test(userAgent)) return "desktop";
  if (/\bCFNetwork\/|\bDarwin\//.test(userAgent) && !/Mozilla\//.test(userAgent)) return "ios";
  if (/\bokhttp\/|\bDalvik\//.test(userAgent)) return "android";
  if (/^Mozilla\//.test(userAgent)) return "browser";
  return "other";
}

/** What a close record says about the peer; nothing here identifies a person or device. */
export interface ClosePeer {
  client: ClientAgent;
  /** Which kind of credential the hello presented, once one did. */
  access?: "host" | "desktop" | "paired";
  /** A side channel (files, devices, browser, screen, provider_auth); absent for the main one. */
  channel?: string;
  remote: boolean;
}

/**
 * The log record for a WebSocket close worth explaining (heartbeat loss, limits, auth,
 * daemon-initiated closes), or undefined for an ordinary one.
 */
export function closeRecord(
  code: number,
  reason: Buffer,
  durationMs: number,
  authenticated: boolean,
  peer: ClosePeer,
):
  | ({ code: number; reason: string; durationMs: number; authenticated: boolean } & ClosePeer)
  | undefined {
  // Unauthenticated drops are mostly probes and abandoned handshakes; keep the daemon's own.
  if (ordinary.has(code) || (!authenticated && code < 4000)) return undefined;
  return {
    code,
    reason: reason.toString("utf8").slice(0, 123),
    durationMs: Math.max(0, durationMs),
    authenticated,
    ...peer,
  };
}
