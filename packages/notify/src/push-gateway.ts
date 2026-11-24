import { createECDH, createHash, randomBytes as systemRandom } from "node:crypto";
import { z } from "zod";
import {
  Notification,
  NotificationDevice,
  PushAccessAlert,
  type PushAccessPayload,
  type PushAlertPayload,
} from "@ace/protocol";
import type { LiveActivityTarget } from "./live-activity.ts";
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
const capabilityLifetimeMs = 60 * 60_000;
const Registration = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/),
  expiresAt: z.number().int().nonnegative(),
});
const Capabilities = z.object({ kinds: z.array(z.string().max(64)) });
/** The part of a stored Live Activity target a gateway registration needs. */
export type ActivityAddress = Pick<LiveActivityTarget, "token" | "environment" | "kind">;
/**
 * What became of an activity registration: `unsupported` is a gateway that doesn't advertise the
 * kind (or an older gateway with no capabilities route), `disabled` is push off on this machine.
 */
export type ActivityRegistration =
  | { status: "registered"; handle: string; expiresAt: number }
  | { status: "unsupported" | "disabled" | "gone" | "failed" }
  | { status: "retry"; retryAfterMs?: number };
export interface PushGatewayTransport extends NotificationTransport, AccessPushTransport {
  registerActivity(address: ActivityAddress, signal: AbortSignal): Promise<ActivityRegistration>;
  /** Drop the cached handle for a token that was removed or whose handle the gateway refused. */
  forgetActivity(address: ActivityAddress): void;
  forget(): void;
}
type Handle = z.infer<typeof Registration>;
type Address = Extract<NotificationDevice["address"], { channel: "push" }>;
type KnownKind = "alert" | "liveactivity" | "start";
type RegistrationOutcome =
  | { ok: true; handle: Handle }
  | { ok: false; status: "gone" | "retry" | "failed"; retryAfterMs?: number };
type CapabilityOutcome =
  | { ok: true; kinds: ReadonlySet<KnownKind> }
  | { ok: false; retryAfterMs?: number };
type HandleLookup =
  | { ok: true; id: string; handle: CachedHandle }
  | Extract<RegistrationOutcome, { ok: false }>;
interface CachedHandle extends Handle {
  /** A hash of the token and environment, so `forgetActivity` never keeps the token itself. */
  address: string;
  kind: KnownKind;
}
const knownKinds = new Set<string>(["alert", "liveactivity", "start"]);
const isKnownKind = (kind: string): kind is KnownKind => knownKinds.has(kind);

function addressHash(address: Address | ActivityAddress): string {
  return createHash("sha256")
    .update(`${address.environment}\n${address.token.toLowerCase()}`)
    .digest("base64url");
}
function handleKey(origin: string, address: Address | ActivityAddress, kind: KnownKind): string {
  return createHash("sha256")
    .update(`${origin}\n${kind}\n${addressHash(address)}`)
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
): PushGatewayTransport {
  const key = p256SigningKey(options.privateKey);
  const handles = new Map<string, CachedHandle>();
  const tokens = new Map<string, { value: string; at: number }>();
  const capabilities = new Map<string, { kinds: ReadonlySet<KnownKind>; at: number }>();
  const capabilityProbes = new Map<string, Promise<CapabilityOutcome>>();
  const registrations = new Map<string, Promise<RegistrationOutcome>>();
  /** Per-token counters so a forgotten registration can't land in the cache afterwards. */
  const invalidations = new Map<string, number>();
  let forgetEpoch = 0;
  const authorization = (origin: string) => {
    const at = now();
    let token = tokens.get(origin);
    if (!token || at - token.at >= 55 * 60_000 || at < token.at) {
      token = { at, value: vapidAuthorization(key, origin, undefined, at) };
      tokens.set(origin, token);
    }
    return token.value;
  };
  const probeCapabilities = async (
    origin: string,
    signal: AbortSignal,
  ): Promise<CapabilityOutcome> => {
    const response = await request(new URL("/v1/capabilities", origin), {
      method: "GET",
      redirect: "error",
      signal,
    });
    // An older gateway has no capabilities route: it sends alerts only, as before.
    if (response.status === 404) {
      await response.body?.cancel();
      return { ok: true, kinds: new Set(["alert"]) };
    }
    if (response.status !== 200) {
      const delay = retryAfterMs(response);
      await response.body?.cancel();
      return delay === undefined ? { ok: false } : { ok: false, retryAfterMs: delay };
    }
    const text = await boundedText(response, 4096);
    const parsed = text === undefined ? undefined : Capabilities.safeParse(safeJson(text));
    if (!parsed?.success) return { ok: false };
    const kinds = new Set<KnownKind>();
    for (const kind of parsed.data.kinds) if (isKnownKind(kind)) kinds.add(kind);
    return { ok: true, kinds };
  };
  const capabilitiesFor = async (origin: string): Promise<CapabilityOutcome> => {
    const at = now();
    const cached = capabilities.get(origin);
    if (cached && at >= cached.at && at - cached.at < capabilityLifetimeMs)
      return { ok: true, kinds: cached.kinds };
    const pending = capabilityProbes.get(origin);
    if (pending) return pending;
    // One probe per origin, with its own deadline: one caller aborting doesn't starve another.
    const probe = probeCapabilities(origin, AbortSignal.timeout(10_000))
      .then((outcome) => {
        if (!outcome.ok) return outcome;
        // Bounded: one entry per gateway origin.
        if (capabilities.size >= 64) capabilities.delete(capabilities.keys().next().value ?? "");
        capabilities.set(origin, { kinds: outcome.kinds, at: now() });
        return outcome;
      })
      .finally(() => capabilityProbes.delete(origin));
    capabilityProbes.set(origin, probe);
    return probe;
  };
  const register = async (
    origin: string,
    address: Address | ActivityAddress,
    kind: KnownKind,
    signal: AbortSignal,
  ): Promise<RegistrationOutcome> => {
    // Old daemons and gateways keep the alert body exactly as it was.
    const body =
      kind === "alert"
        ? { token: address.token, environment: address.environment }
        : { token: address.token, environment: address.environment, kind };
    const response = await request(new URL("/v1/registrations", origin), {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: authorization(origin) },
      body: JSON.stringify(body),
    });
    if (response.status !== 201) {
      const delay = retryAfterMs(response);
      await response.body?.cancel();
      if (response.status === 410) return { ok: false, status: "gone" };
      if (response.status === 429 || response.status >= 500)
        return delay === undefined
          ? { ok: false, status: "retry" }
          : { ok: false, status: "retry", retryAfterMs: delay };
      // Alerts keep their old mapping. An activity registration refused this way is permanent.
      if (response.status === 404 || (response.status === 403 && kind === "alert"))
        return { ok: false, status: "retry" };
      return { ok: false, status: "failed" };
    }
    const text = await boundedText(response, 4096);
    const parsed = text === undefined ? undefined : Registration.safeParse(safeJson(text));
    return parsed?.success ? { ok: true, handle: parsed.data } : { ok: false, status: "retry" };
  };
  const registerOnce = (
    origin: string,
    address: Address | ActivityAddress,
    kind: KnownKind,
    signal: AbortSignal,
  ) => {
    const id = handleKey(origin, address, kind);
    const pending = registrations.get(id);
    if (pending) return pending;
    const registration = register(origin, address, kind, signal).finally(() =>
      registrations.delete(id),
    );
    registrations.set(id, registration);
    return registration;
  };
  const handleFor = async (
    origin: string,
    address: Address | ActivityAddress,
    kind: KnownKind,
    signal: AbortSignal,
  ): Promise<HandleLookup> => {
    const id = handleKey(origin, address, kind);
    const cached = handles.get(id);
    if (cached && cached.expiresAt - renewBeforeMs > now()) return { ok: true, id, handle: cached };
    const invalidated = `${kind}\n${addressHash(address)}`;
    const forgotten = invalidations.get(invalidated) ?? 0;
    const epoch = forgetEpoch;
    const fresh = await registerOnce(origin, address, kind, signal);
    // The caller may have gone away while sharing this registration with another caller.
    if (signal.aborted) return { ok: false, status: "retry" };
    if (!fresh.ok) return fresh;
    const entry: CachedHandle = { ...fresh.handle, address: addressHash(address), kind };
    // forgetActivity (or forget) may have run while the request was in flight. An activity
    // caller must not use a handle the daemon has already dropped; a fresh one comes next time.
    if (epoch !== forgetEpoch || (invalidations.get(invalidated) ?? 0) !== forgotten)
      return kind === "alert" ? { ok: true, id, handle: entry } : { ok: false, status: "retry" };
    // Bounded: one entry per phone token and kind, capped like the device table.
    if (handles.size >= 256) handles.delete(handles.keys().next().value ?? "");
    handles.set(id, entry);
    return { ok: true, id, handle: entry };
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
        const found = await handleFor(target.origin, address, "alert", requestSignal);
        if (!found.ok) return found.status;
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
  const registerActivity = async (
    address: ActivityAddress,
    signal: AbortSignal,
  ): Promise<ActivityRegistration> => {
    if (signal.aborted) return { status: "retry" };
    try {
      const target = await options.target();
      // Push is off on this machine: no handle is registered for a push that won't happen.
      if (!target.enabled) return { status: "disabled" };
      const supported = await capabilitiesFor(target.origin);
      if (!supported.ok)
        return supported.retryAfterMs === undefined
          ? { status: "retry" }
          : { status: "retry", retryAfterMs: supported.retryAfterMs };
      if (!supported.kinds.has(address.kind)) return { status: "unsupported" };
      if (signal.aborted) return { status: "retry" };
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const found = await handleFor(target.origin, address, address.kind, requestSignal);
      if (!found.ok) {
        if (found.status === "gone") {
          // A delayed 410 belongs to the gateway that was active when the request started.
          const current = await options.target();
          if (signal.aborted || !current.enabled || current.origin !== target.origin)
            return { status: "retry" };
          return { status: "gone" };
        }
        if (found.status === "failed") return { status: "failed" };
        return found.retryAfterMs === undefined
          ? { status: "retry" }
          : { status: "retry", retryAfterMs: found.retryAfterMs };
      }
      return {
        status: "registered",
        handle: found.handle.handle,
        expiresAt: found.handle.expiresAt,
      };
    } catch {
      return { status: "retry" };
    }
  };
  const forgetActivity = (address: ActivityAddress) => {
    const hash = addressHash(address);
    const wanted = `${address.kind}\n${hash}`;
    if (invalidations.size >= 256) invalidations.delete(invalidations.keys().next().value ?? "");
    invalidations.set(wanted, (invalidations.get(wanted) ?? 0) + 1);
    for (const [id, entry] of handles)
      if (entry.kind === address.kind && entry.address === hash) handles.delete(id);
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
    registerActivity,
    forgetActivity,
    forget() {
      forgetEpoch++;
      handles.clear();
      tokens.clear();
      capabilities.clear();
      invalidations.clear();
    },
  };
}
function statusResult(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 410) return "gone";
  if (status === 429 || status >= 500 || status === 404 || status === 403) return "retry";
  return "failed";
}
/** The longest delay a JavaScript timer accepts without overflowing. */
const maxTimerMs = 2 ** 31 - 1;
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(maxTimerMs, Math.ceil(seconds * 1000));
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
