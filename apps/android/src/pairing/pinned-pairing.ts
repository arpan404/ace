import { ClientCore, ClientError } from "@ace/client";
import { DeviceCredential, DeviceId } from "@ace/protocol";
import { accessJson, TrustMonitor } from "../security/pinned-transport.ts";
import {
  bridgePinnedHttp,
  bridgeSocketTransport,
  ticketFetch,
  type ExpoPinnedBridge,
} from "../security/expo-bridge.ts";
import { pairedSocketCredential, socketUrlFor } from "./tickets.ts";
import type { PairingTransport } from "./pairing-flow.ts";

/**
 * Production `PairingTransport` over the native pinned bridge.
 *
 * Mirrors the iOS pairing path (`BridgeMachineAccess.pair` plus
 * `access-entry.ts readIdentity`): the code is POSTed once to
 * `origin/v1/pair` over pinned HTTPS with the link's fingerprint validated
 * before anything is sent, then a short-lived pinned connection
 * authenticated as the newly minted device reads `host.identity` on the same
 * pin. The entry is bound to that authenticated identity, never the link
 * hostname. The React Native default fetch/WebSocket never carries pairing
 * material.
 *
 * The transport object is created per pairing attempt. `redeem` captures the
 * minted device id and token for the later identity read; `readIdentity`
 * before a successful redeem fails closed.
 */

export interface PinnedPairingClocks {
  readonly set: (delayMs: number, callback: () => void) => () => void;
  readonly id: () => string;
  readonly random: () => number;
  readonly now: () => number;
}

export interface PinnedPairingOptions {
  readonly bridge: ExpoPinnedBridge;
  readonly socketId?: (() => string) | undefined;
  readonly clocks?: Partial<PinnedPairingClocks> | undefined;
  /** How long the identity read waits for the fresh ticket connection. */
  readonly identityTimeoutMs?: number | undefined;
}

const IDENTITY_TIMEOUT_MS = 15_000;

const noop = () => {};

/**
 * A short-lived authenticated identity connection, injectable so tests never
 * need a socket or daemon. Production opens a real `ClientCore` over the
 * pinned bridge with a fresh ticket exchanged for the minted token.
 */
export type IdentityReader = (input: {
  socketUrl: string;
  fingerprint: string;
  deviceId: string;
  token: string;
  signal?: AbortSignal | undefined;
}) => Promise<unknown>;

export function createPinnedPairingTransport(
  options: PinnedPairingOptions,
  identityReader?: IdentityReader | undefined,
): PairingTransport {
  let minted: { deviceId: string; token: string } | undefined;
  const readIdentityImpl = identityReader ?? defaultIdentityReader(options);
  return {
    async redeem(input) {
      if (input.signal?.aborted === true) throw withCode(abortError());
      const http = bridgePinnedHttp(options.bridge, {
        origin: input.origin,
        fingerprint: input.fingerprint,
      });
      const trust = new TrustMonitor();
      const raw = await raceWithAbort(
        accessJson(
          http,
          {
            method: "POST",
            path: "/v1/pair",
            body: JSON.stringify({ code: input.code, name: input.name }),
          },
          trust,
        ),
        input.signal,
      ).catch((error: unknown) => {
        throw withCode(error);
      });
      // Capture the minted device when readable. When it is not, return the
      // raw reply untouched: redemption already burned the code, so the flow
      // reports `consumed` (remove the duplicate device, create a new link)
      // instead of a retryable error.
      const credential = DeviceCredential.safeParse(raw);
      if (credential.success)
        minted = { deviceId: credential.data.device.id, token: credential.data.token };
      return raw;
    },
    async readIdentity(input) {
      if (input.signal?.aborted === true) throw withCode(abortError());
      const device = minted;
      if (device === undefined) throw daemonError("Pairing has not redeemed a device yet.");
      const socketUrl = socketUrlFor(input.origin);
      const raw = await readIdentityImpl({
        socketUrl,
        fingerprint: input.fingerprint,
        deviceId: device.deviceId,
        token: device.token,
        signal: input.signal,
      }).catch((error: unknown) => {
        throw withCode(error);
      });
      // Like `redeem`, return the raw reply: the flow reports an unreadable
      // identity as `consumed`, since the code is already burned.
      return raw;
    },
  };
}

/**
 * Abort stops waiting and closes the short-lived socket; it cannot cancel
 * the native request itself, and a code burned before the abort still reads
 * as `consumed` upstream.
 */
function raceWithAbort<T>(work: Promise<T>, signal?: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function abortError(): Error & { code: string } {
  const error = new Error("Pairing was cancelled.") as Error & { code: string };
  error.code = "aborted";
  return error;
}

function defaultIdentityReader(options: PinnedPairingOptions): IdentityReader {
  return async ({ socketUrl, fingerprint, deviceId, token, signal }) => {
    const clocks = options.clocks ?? {};
    const set =
      clocks.set ??
      ((delayMs: number, callback: () => void) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    let ids = 0;
    const id = clocks.id ?? (() => `pairing-${Date.now()}-${(ids += 1)}`);
    const random = clocks.random ?? (() => Math.random());
    const now = clocks.now ?? (() => Date.now());
    const trust = new TrustMonitor();
    const http = bridgePinnedHttp(options.bridge, {
      origin: httpsOriginFor(socketUrl),
      fingerprint,
    });
    const client = new ClientCore({
      deviceId: DeviceId.parse(deviceId),
      transport: () =>
        bridgeSocketTransport(options.bridge, {
          url: socketUrl,
          fingerprint,
          id: options.socketId ?? (() => id()),
          trust,
        }),
      credential: pairedSocketCredential({
        socketUrl,
        token: async () => token,
        fetch: ticketFetch(http),
      }),
      storage: { load: async () => null, save: async () => {} },
      scheduler: { set },
      id,
      random,
      now,
    });
    if (signal?.aborted === true) throw abortError();
    const connection = client.connectionState();
    let stop: () => void = noop;
    let cancel: () => void = noop;
    try {
      const ready = new Promise<void>((resolve, reject) => {
        cancel = set(options.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS, () =>
          reject(new ClientError("offline", "This computer didn't respond.")),
        );
        const changed = () => {
          const state = connection.getSnapshot();
          if (state === "ready") resolve();
          else if (state === "fatal") reject(client.error ?? new ClientError("auth"));
          else if (state === "reconnecting") reject(new ClientError("offline"));
        };
        stop = connection.subscribe(changed);
        changed();
      });
      await raceWithAbort(Promise.all([client.start(), ready]), signal);
      const result = await raceWithAbort(
        client.request({ type: "host.identity", requestId: id() }),
        signal,
      );
      const identity = (result as { identity?: unknown }).identity;
      return identity;
    } finally {
      stop();
      cancel();
      await client.close();
    }
  };
}

/** HTTPS origin of the same daemon listener, for the ticket exchange. */
function httpsOriginFor(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Surface bridge failures with the `code` shape `pairing-flow.ts` maps:
 * pin and credential refusals read as `auth`, oversized replies as `limit`,
 * malformed work as `protocol`, unreachable computers as `offline`.
 */
function withCode(error: unknown): Error & { code: string } {
  if (error instanceof ClientError) {
    const known = ["auth", "offline", "limit", "protocol", "daemon"] as const;
    const code = (known as readonly string[]).includes(error.code) ? error.code : "daemon";
    const mapped = new Error(error.message) as Error & { code: string };
    mapped.code = code;
    return mapped;
  }
  if (error instanceof Error && "code" in error) return error as Error & { code: string };
  if (error instanceof Error && error.name === "AbortError") return abortError();
  const offline = new Error(
    error instanceof Error ? error.message : "Pairing failed. Try again.",
  ) as Error & { code: string };
  offline.code = "offline";
  return offline;
}

function daemonError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "daemon";
  return error;
}
