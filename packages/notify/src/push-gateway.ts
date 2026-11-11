import { createECDH, createHash, randomBytes as systemRandom } from "node:crypto";
import { z } from "zod";
import {
  Notification,
  NotificationDevice,
  PushAccessAlert,
  type PushAccessPayload,
  type PushAlertPayload,
} from "@ace/protocol";
import { encryptWebPush, p256SigningKey, vapidAuthorization } from "./webpush-crypto.ts";
import type { DeliveryResult, NotificationTransport } from "./service.ts";

/** Where to push now; read at every send so a settings change applies at once. */
export interface PushGatewayTarget {
  enabled: boolean;
  /** HTTPS origin of the gateway (ADR 0106). */
  origin: string;
}
export interface PushGatewayOptions {
  /** This daemon's own P-256 key (PEM): its identity at the gateway. */
  privateKey: string;
  /** Put in every alert so the phone knows which machine raised it. */
  hostId: string;
  target: () => PushGatewayTarget | Promise<PushGatewayTarget>;
}
/** The plaintext budget that keeps every body under the gateway's 2,800-byte limit. */
export const pushPlaintextBudget = 2600;
const renewBeforeMs = 24 * 60 * 60_000;
const Registration = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/),
  expiresAt: z.number().int().nonnegative(),
});
type Handle = z.infer<typeof Registration>;
type Address = Extract<NotificationDevice["address"], { channel: "push" }>;

function handleKey(origin: string, address: Address): string {
  return createHash("sha256")
    .update(`${origin}\n${address.environment}\n${address.token.toLowerCase()}`)
    .digest("base64url");
}
/**
 * The bounded alert a phone can read: the full alert when it fits, otherwise without the
 * preview, the agent's message and the catch-up list, in that order. Never more than the
 * local path shows.
 */
export function pushPlaintext(hostId: string, notification: Notification): Buffer {
  const encode = (value: Notification) =>
    Buffer.from(JSON.stringify({ v: 1, hostId, notification: value } satisfies PushAlertPayload));
  let value = notification;
  let bytes = encode(value);
  for (const field of ["preview", "message", "threadIds"] as const) {
    if (bytes.length <= pushPlaintextBudget) break;
    const trimmed = { ...value };
    delete trimmed[field];
    value = trimmed;
    bytes = encode(value);
  }
  if (bytes.length > pushPlaintextBudget)
    bytes = encode({ ...value, title: value.title.slice(0, 80) });
  return bytes;
}

/** The sign-in alert a phone can read (ADR 0122): small and fixed, so it always fits. */
export function pushAccessPlaintext(hostId: string, access: PushAccessAlert): Buffer {
  const { requestId, clientName, domain, matchCode, expiresAt } = PushAccessAlert.parse(access);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      hostId,
      access: { requestId, clientName, domain, matchCode, expiresAt },
    } satisfies PushAccessPayload),
  );
}
/** Sends an outside client's sign-in request to a phone, encrypted like every alert. */
export interface AccessPushTransport {
  sendAccess(
    device: unknown,
    access: PushAccessAlert,
    signal: AbortSignal,
  ): Promise<DeliveryResult>;
}
interface Sealed {
  plaintext: Buffer;
  /** Seconds the gateway and APNs may hold it. */
  ttl: number;
  urgency: "high" | "low";
  /** The same id replaces itself on the phone rather than stacking. */
  collapse: string;
}

/**
 * Alerts to phones through the push gateway. Each alert is encrypted to the phone's key
 * (RFC 8291) before it leaves the machine; the gateway and Apple see only ciphertext. Handles
 * are registered on first use and kept in memory; a restart registers again.
 */
export function createPushGatewayTransport(
  options: PushGatewayOptions,
  now: () => number,
  request: typeof fetch = fetch,
  random: (size: number) => Buffer = systemRandom,
): NotificationTransport & AccessPushTransport & { forget(): void } {
  const key = p256SigningKey(options.privateKey);
  const handles = new Map<string, Handle>();
  const tokens = new Map<string, { value: string; at: number }>();
  const authorization = (origin: string) => {
    const at = now();
    let token = tokens.get(origin);
    if (!token || at - token.at >= 55 * 60_000 || at < token.at) {
      token = { at, value: vapidAuthorization(key, origin, undefined, at) };
      tokens.set(origin, token);
    }
    return token.value;
  };
  const register = async (
    origin: string,
    address: Address,
    signal: AbortSignal,
  ): Promise<Handle | DeliveryResult> => {
    const response = await request(new URL("/v1/registrations", origin), {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: authorization(origin) },
      body: JSON.stringify({ token: address.token, environment: address.environment }),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      return statusResult(response.status);
    }
    const text = await boundedText(response, 4096);
    const parsed = text === undefined ? undefined : Registration.safeParse(safeJson(text));
    return parsed?.success ? parsed.data : "retry";
  };
  const handleFor = async (origin: string, address: Address, signal: AbortSignal) => {
    const id = handleKey(origin, address);
    const cached = handles.get(id);
    if (cached && cached.expiresAt - renewBeforeMs > now()) return { id, handle: cached };
    const fresh = await register(origin, address, signal);
    if (typeof fresh === "string") return fresh;
    // Bounded: one entry per phone token, capped like the device table.
    if (handles.size >= 256) handles.delete(handles.keys().next().value ?? "");
    handles.set(id, fresh);
    return { id, handle: fresh };
  };
  const post = async (
    origin: string,
    handle: Handle,
    address: Address,
    sealed: Sealed,
    signal: AbortSignal,
  ) => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const body = encryptWebPush({
      subscription: { endpoint: origin, p256dh: address.p256dh, auth: address.auth },
      plaintext: sealed.plaintext,
      salt: random(16),
      privateKey: ecdh.getPrivateKey(),
    });
    const response = await request(new URL(`/v1/push/${handle.handle}`, origin), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: String(sealed.ttl),
        urgency: sealed.urgency,
        topic: createHash("sha256").update(sealed.collapse).digest("base64url").slice(0, 32),
        authorization: authorization(origin),
      },
      body: new Uint8Array(body),
    });
    await response.body?.cancel();
    return response.status;
  };
  const deliver = async (
    deviceInput: unknown,
    sealed: Sealed,
    signal: AbortSignal,
  ): Promise<DeliveryResult> => {
    const address = NotificationDevice.parse(deviceInput).address;
    if (address.channel !== "push") return "failed";
    if (signal.aborted) return "retry";
    const target = await options.target();
    // Push is off on this machine: the phone is reached only while its app runs.
    if (!target.enabled) return "retry";
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = await handleFor(target.origin, address, requestSignal);
        if (typeof found === "string") return found;
        const status = await post(target.origin, found.handle, address, sealed, requestSignal);
        // An unreadable or expired handle (the gateway rotated its key): register once more.
        if (status === 404 || status === 403) {
          handles.delete(found.id);
          continue;
        }
        return statusResult(status);
      }
      return "retry";
    } catch {
      return "retry";
    }
  };
  return {
    send(device, notificationInput, signal) {
      const notification = Notification.parse(notificationInput);
      return deliver(
        device,
        {
          plaintext: pushPlaintext(options.hostId, notification),
          ttl: 86_400,
          urgency: notification.status === "background_done" ? "low" : "high",
          collapse: notification.id,
        },
        signal,
      );
    },
    sendAccess(device, access, signal) {
      // Held no longer than the request lives: a late push would name a sign-in that ended.
      const ttl = Math.ceil((access.expiresAt - now()) / 1000);
      if (ttl <= 0) return Promise.resolve("failed");
      return deliver(
        device,
        {
          plaintext: pushAccessPlaintext(options.hostId, access),
          ttl: Math.min(ttl, 86_400),
          urgency: "high",
          collapse: `access:${access.requestId}`,
        },
        signal,
      );
    },
    forget() {
      handles.clear();
      tokens.clear();
    },
  };
}
function statusResult(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 410) return "gone";
  if (status === 429 || status >= 500 || status === 404 || status === 403) return "retry";
  return "failed";
}
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
