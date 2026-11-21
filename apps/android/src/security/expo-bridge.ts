import type { Transport } from "@ace/client";
import type { AccessOptions } from "@ace/client/access";
import {
  createPinnedHttp,
  PinnedTransportError,
  TrustMonitor,
  validateSocketTarget,
  type NativePinnedHttp,
  type PinnedHttp,
} from "./pinned-transport.ts";
import { isPin } from "./trust.ts";

/**
 * The Expo side of the native pinned TLS boundary (`modules/ace-native`).
 *
 * This module adapts the native module's pinned HTTPS/WebSocket bridge to the
 * shapes the shared SDK consumes. It performs no networking itself and holds
 * no secrets: the pin is validated in JS before every call (mirroring iOS
 * `PinnedHTTP`/`PinnedSocket`), and TLS re-verifies it during the handshake
 * before any request bytes are written. The React Native default
 * fetch/WebSocket must never carry pairing material.
 */

export type ExpoSocketEventType = "open" | "message" | "binary" | "trust" | "close";

export interface ExpoSocketEvent {
  readonly id: string;
  readonly type: ExpoSocketEventType;
  readonly value: string;
}

/**
 * Minimal native-module shape. Production passes the real `AceNative` module
 * (via `requireNativeModule("AceNative")`); tests inject fakes. Resolved with
 * `expoBridgeFromModule`, which fails closed when the bridge is missing.
 */
export interface ExpoPinnedBridge {
  pinnedFetch(input: {
    readonly origin: string;
    readonly fingerprint: string;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: string | undefined;
    readonly token?: string | undefined;
  }): Promise<{ status: number; body: string }>;
  pinnedSocketOpen(id: string, url: string, fingerprint: string): void;
  pinnedSocketSend(id: string, text: string): void;
  pinnedSocketClose(id: string): void;
  addSocketListener(listener: (event: ExpoSocketEvent) => void): () => void;
}

/**
 * Validate a raw native module against the pinned-bridge shape. Throws when
 * any entry is missing, so a mis-registered module fails closed before any
 * credential is touched instead of silently dropping pairing traffic.
 */
export function expoBridgeFromModule(module: unknown): ExpoPinnedBridge {
  const candidate = module as Record<string, unknown> | null | undefined;
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate.pinnedFetch !== "function" ||
    typeof candidate.pinnedSocketOpen !== "function" ||
    typeof candidate.pinnedSocketSend !== "function" ||
    typeof candidate.pinnedSocketClose !== "function" ||
    typeof candidate.addSocketListener !== "function"
  ) {
    throw new Error("The pinned native bridge is unavailable in this build.");
  }
  return candidate as unknown as ExpoPinnedBridge;
}

/**
 * Bind one daemon origin and its confirmed pin to the native pinned HTTPS
 * bridge. The pin is re-checked here before delegating, so a compromised or
 * confused caller cannot send a token or ticket past JS validation; the
 * native layer enforces it again during the TLS handshake.
 */
export function bridgePinnedHttp(
  bridge: ExpoPinnedBridge,
  binding: { origin: string; fingerprint: string },
): PinnedHttp {
  const native: NativePinnedHttp = async (input) => {
    if (!isPin(input.fingerprint)) throw new Error("invalid");
    return bridge.pinnedFetch(input);
  };
  return createPinnedHttp(native, binding);
}

/**
 * Adapt the native pinned fetch to the `fetch` shape the shared ticket
 * exchange consumes (`AccessOptions["fetch"]`). Each connection attempt
 * exchanges the device token for a fresh single-use ticket over this fetch;
 * tickets are never cached.
 *
 * Trust reporting: a native pin refusal is reported to `trust` (the same
 * per-machine `TrustMonitor` the socket path reports to) and returned as a
 * synthetic `401` so the shared `accessHttp` maps it to an `auth` failure
 * while `startupRoute` still sees the pin reason and routes to pairing with
 * a mismatch message. Other refusals collapse to the closest shared
 * outcome the ticket path can express without changing the shared
 * contract: `limit` returns an oversized 200 body so `accessHttp` raises
 * `limit`, `redirect`/`invalid` return `400` (`daemon` downstream; both
 * stay paired), and `offline` rethrows (`offline` downstream).
 *
 * Abort: the native bridge cannot cancel an in-flight request. When
 * `init.signal` aborts, this stops waiting and rejects with an abort
 * error; the late native result is ignored and never reported to `trust`
 * (an abort leaves a previous pin failure untouched: only a live refusal
 * reports it). The shared `accessHttp` maps that abort to `offline`, so
 * callers must not read it as a completed exchange: an aborted ticket
 * attempt keeps retrying with backoff like any offline failure.
 * `Client.close` stops those retries (the connection epoch guard drops the
 * late credential and the closed flag blocks reconnect and wake); see
 * `production-runtime.test.ts` ("close during a hanging ticket exchange
 * stops retries") and `README.md` for the full limitation.
 *
 * Trust is never cleared here. A pinned-HTTPS success cannot prove the pin
 * matched: on a `*.ts.net` host the native layer may accept the publicly
 * trusted Tailscale certificate for that name with a mismatched pin (ADR
 * 0097), and this bridge reports no which-path signal, so clearing on
 * success would hide a genuine mismatch behind Tailscale trust. A pin
 * failure sticks until the binding changes (a fresh monitor per pin plus
 * device), the machine is removed or pruned, or a later refusal re-reports
 * it. iOS clears its monitor when the SDK connection reaches `ready`; this
 * boundary is deliberately stricter because a single ticket `200` is a
 * weaker signal than a fully authenticated session.
 */
export function ticketFetch(
  http: PinnedHttp,
  options?: { trust?: TrustMonitor | undefined },
): AccessOptions["fetch"] {
  const trust = options?.trust;
  return async (input: string, init: RequestInit) => {
    const signal = init.signal ?? null;
    const aborted = (): boolean => signal !== null && signal.aborted;
    if (aborted()) throw abortError();
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers =
      init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers as HeadersInit | undefined);
    const authorization = headers.get("authorization");
    const token =
      authorization !== null && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
    const body = typeof init.body === "string" ? init.body : undefined;
    const request = {
      method: method === "POST" ? "POST" : "GET",
      path: url.pathname,
      body,
      token,
    } as const;
    let onAbort: (() => void) | undefined;
    try {
      const pending = http(request);
      const attempted =
        signal === null
          ? await pending
          : await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                onAbort = () => reject(abortError());
                signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
      if (aborted()) throw abortError();
      // No trust clear on success: see the header comment (ADR 0097
      // `*.ts.net` fallback). A stale late success must never clear a
      // replacement's failure either; since nothing here clears, there is
      // nothing a stale callback can wipe.
      return new Response(attempted.body, { status: attempted.status });
    } catch (error) {
      if (aborted()) throw abortError();
      if (error instanceof PinnedTransportError) {
        if (error.refusal === "pin") {
          trust?.report("pin");
          return new Response("pin mismatch", { status: 401 });
        }
        if (error.refusal === "limit") {
          return new Response("x".repeat(1_048_577), { status: 200 });
        }
        if (error.refusal === "redirect" || error.refusal === "invalid") {
          return new Response(error.refusal, { status: 400 });
        }
      }
      throw error;
    } finally {
      if (signal !== null && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };
}

function abortError(): Error {
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }
}

/** Decode standard base64 (padded or not) without relying on a global. */
export function base64ToBytes(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid socket frame encoding");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export interface PinnedSocketOptions {
  readonly url: string;
  readonly fingerprint: string;
  /** Fresh id per runtime, so a stale socket's frames can never name a replacement. */
  readonly id: () => string;
  readonly trust?: TrustMonitor | undefined;
  /**
   * Epoch guard from the multi-machine manager: when present and false, the
   * runtime no longer owns its machine and its frames are dropped. The native
   * registry and per-socket ids already stop cross-session delivery; this
   * stops a replaced runtime's own late frames from reaching the new owner.
   */
  readonly isCurrent?: (() => boolean) | undefined;
}

/**
 * A pinned WSS transport for one paired machine, mirroring iOS
 * `PinnedSocket` over the Expo bridge. Production requires pinned WSS and an
 * exact pin; validation throws before any socket opens. Each `open` mints a
 * fresh bridge id and subscribes only to it; `close` unsubscribes first, so a
 * replaced runtime's late close can never drop or feed its replacement.
 */
export function bridgeSocketTransport(
  bridge: ExpoPinnedBridge,
  options: PinnedSocketOptions,
): Transport {
  const endpoint = validateSocketTarget(options.url, options.fingerprint);
  let active: { id: string; release: () => void } | undefined;
  let owned = true;

  function current(): boolean {
    if (!owned || active === undefined) return false;
    if (options.isCurrent !== undefined && !options.isCurrent()) return false;
    return true;
  }

  return {
    supportsBinary: true,
    open(events) {
      if (active !== undefined) {
        try {
          active.release();
        } catch {
          // Best effort; the replacement below takes over regardless.
        }
        try {
          bridge.pinnedSocketClose(active.id);
        } catch {
          // Already gone; the new socket still opens.
        }
      }
      const id = options.id();
      const release = bridge.addSocketListener((event) => {
        if (event.id !== id || !current()) return;
        if (event.type === "open") {
          // `open` cannot prove the pin matched on a `*.ts.net` host (ADR
          // 0097 system-trust fallback), so it never clears trust: a
          // previous pin failure sticks until the binding changes. Stale
          // runtimes never reach here (`current()` already returned false
          // above), so one machine's late open cannot touch another's
          // monitor or deliver frames to the new owner.
          events.open();
        } else if (event.type === "message") events.message(event.value);
        else if (event.type === "binary") {
          let bytes: Uint8Array;
          try {
            bytes = base64ToBytes(event.value);
          } catch {
            events.close(1002, "Unreadable frame");
            return;
          }
          if (events.binary !== undefined) events.binary(bytes);
          else {
            events.close(4002, "Unsupported frame type");
          }
        } else if (event.type === "trust") options.trust?.report(event.value);
        else if (event.type === "close") {
          const code = Number(event.value);
          active = undefined;
          release();
          events.close(Number.isFinite(code) ? code : 1006);
        }
      });
      active = { id, release };
      try {
        bridge.pinnedSocketOpen(id, endpoint, options.fingerprint);
      } catch {
        active = undefined;
        try {
          release();
        } catch {
          // Listener setup already failed; nothing to retain.
        }
        events.close(1006, "Socket error");
      }
    },
    send(text) {
      const socket = active;
      if (socket === undefined) throw new Error("Transport not open");
      bridge.pinnedSocketSend(socket.id, text);
    },
    close() {
      owned = false;
      const socket = active;
      active = undefined;
      if (socket !== undefined) {
        try {
          socket.release();
        } catch {
          // Listener already gone; still close the native socket.
        }
        try {
          bridge.pinnedSocketClose(socket.id);
        } catch {
          // Already gone; ownership is already released above.
        }
      }
    },
  };
}
