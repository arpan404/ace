import { ClientError, accessResponseError, ticketCredential } from "@ace/client";
import type { ConnectionState } from "@ace/client";
import { DeviceCredential, PairingRedemption } from "@ace/protocol";
import { z } from "zod";

/**
 * One request over native pinned HTTPS. Swift owns the origin and the QR-confirmed SPKI pin,
 * refuses redirects and caps the body; the bridge supplies only a fixed `/v1/` path.
 */
export interface PinnedRequest {
  method: "GET" | "POST";
  path: string;
  body?: string;
  token?: string;
}
export interface PinnedResponse {
  status: number;
  body: string;
}
export type PinnedHttp = (request: PinnedRequest) => Promise<PinnedResponse>;

/** Refusal reasons the native transport reports instead of a response. */
const Refusal = z.enum(["pin", "redirect", "offline", "limit", "invalid"]);
type Refusal = z.infer<typeof Refusal>;

/**
 * Remembers that the native layer refused this computer's TLS key. The SDK folds every
 * non-network credential failure into `auth`, so the reason is kept beside it for the UI.
 */
export class TrustMonitor {
  #failure: "pin" | undefined;
  get failure(): "pin" | undefined {
    return this.#failure;
  }
  report(reason: string): void {
    if (reason === "pin") this.#failure = "pin";
  }
  clear(): void {
    this.#failure = undefined;
  }
}

function refusal(error: unknown): Refusal {
  const parsed = Refusal.safeParse(error instanceof Error ? error.message : error);
  return parsed.success ? parsed.data : "offline";
}

/** The SDK's HTTP status policy applies; transport refusals keep their own reason. */
export async function accessJson(
  http: PinnedHttp,
  request: PinnedRequest,
  trust?: TrustMonitor,
): Promise<unknown> {
  let response: PinnedResponse;
  try {
    response = await http(request);
  } catch (error) {
    const reason = refusal(error);
    trust?.report(reason);
    if (reason === "pin") throw new ClientError("auth", "TLS public-key fingerprint mismatch");
    if (reason === "redirect") throw new ClientError("protocol", "Redirect refused");
    if (reason === "limit") throw new ClientError("limit", "Response too large");
    throw new ClientError(
      "offline",
      "Couldn't reach this computer. Check the connection and try again.",
    );
  }
  if (response.status !== 200) throw accessResponseError(response.status);
  try {
    const value: unknown = JSON.parse(response.body);
    return value;
  } catch {
    throw new ClientError("protocol", "Invalid JSON response");
  }
}

/** Redeem a pairing code. The code travels only in the POST body, never in a URL. */
export async function redeemPairing(
  http: PinnedHttp,
  code: string,
  name: string,
  trust?: TrustMonitor,
): Promise<DeviceCredential> {
  const body = JSON.stringify(PairingRedemption.parse({ code, name }));
  return DeviceCredential.parse(
    await accessJson(http, { method: "POST", path: "/v1/pair", body }, trust),
  );
}

/** A fresh single-use ticket for every socket attempt, exchanged with the stored device token. */
export function pairedCredential(
  http: PinnedHttp,
  token: () => Promise<string>,
  trust?: TrustMonitor,
): () => Promise<{ ticket: string }> {
  return ticketCredential(token, (value) =>
    accessJson(http, { method: "POST", path: "/v1/tickets", token: value }, trust),
  );
}

export interface Problem {
  code:
    | "expired"
    | "rate"
    | "disabled"
    | "pin"
    | "redirect"
    | "unreachable"
    | "offline"
    | "revoked"
    | "identity"
    | "version"
    | "storage"
    | "duplicate"
    | "unknown";
  message: string;
}

const messages: Record<Problem["code"], string> = {
  expired:
    "This pairing link expired or was already used. Create a new one on your computer and scan it again.",
  rate: "Too many pairing attempts. Wait a minute, then try again.",
  disabled: "Remote access is off on that computer. Turn it on in Settings > Remote devices.",
  pin: "This computer's identity doesn't match the pairing link. Nothing was sent. Pair again with a fresh link from that computer.",
  redirect: "That address tried to redirect the connection. ace refuses redirects; check the link.",
  unreachable:
    "Can't reach this computer. Check that it's awake and on the same network or tailnet. ace keeps retrying.",
  offline: "You're offline. Sends wait on this phone until the connection returns.",
  revoked:
    "This phone's access was removed or no longer works. Pair again from Remote devices on that computer.",
  identity: "A different computer answered at this address. Pair again with a fresh link.",
  version: "This computer runs a different ace version. Update ace on both devices.",
  storage: "Couldn't save on this phone. Free some space and try again.",
  duplicate: "This computer is already paired. Remove it first to pair again.",
  unknown: "Couldn't complete pairing. Create a new link and try again.",
};
export function problem(code: Problem["code"]): Problem {
  return { code, message: messages[code] };
}

/** A pairing failure the person can act on. */
export function pairingProblem(error: unknown, trust?: TrustMonitor): Problem {
  if (trust?.failure === "pin") return problem("pin");
  if (!(error instanceof ClientError)) return problem("unknown");
  if (error.message === "HTTP 401") return problem("expired");
  if (error.message === "HTTP 429") return problem("rate");
  if (error.message === "HTTP 409") return problem("disabled");
  if (error.message === "Redirect refused") return problem("redirect");
  if (error.code === "offline" || error.code === "timeout") return problem("unreachable");
  if (error.code === "auth") return problem("revoked");
  if (error.code === "identity") return problem("identity");
  if (error.code === "protocol" || error.code === "version_mismatch") return problem("version");
  if (error.code === "storage")
    return error.message.includes("already paired") ? problem("duplicate") : problem("storage");
  return problem("unknown");
}

/**
 * Why the SDK's connection is not ready, for a person. The SDK keeps retrying unreachable
 * hosts; only fatal states need a new pairing.
 */
export function connectionProblem(
  state: ConnectionState,
  error: ClientError | undefined,
  trust?: TrustMonitor,
): Problem | null {
  if (state === "ready" || state === "connecting" || state === "starting") return null;
  if (trust?.failure === "pin") return problem("pin");
  if (state === "offline") return problem("offline");
  if (state === "reconnecting") return problem("unreachable");
  if (!error || error.code === "auth") return problem("revoked");
  if (error.code === "identity") return problem("identity");
  if (error.code === "storage") return problem("storage");
  return problem("version");
}
