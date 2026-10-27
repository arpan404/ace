import { PairingRedemption } from "@ace/protocol";
import { isPin } from "../security/trust.ts";
import { accessJson, type PinnedHttp } from "../security/pinned-transport.ts";
import { PairingFlowError, type ConfirmedPairing, type PairingTransport } from "./pairing-flow.ts";
import { PAIRING_UNAVAILABLE_MESSAGE } from "./pairing-view.ts";

/**
 * Pinned pairing transport for the Android pairing screen.
 *
 * `redeemConfirmedPairing` (`pairing-flow.ts`) performs no networking itself:
 * it needs a `PairingTransport` whose `redeem` POSTs `{ code, name }` to
 * `origin/v1/pair` over the pinned transport and whose `readIdentity`
 * returns the `host.identity` result read on the pinned,
 * ticket-authenticated connection. This module builds that transport from
 * injected pieces so the screen stays testable without the device:
 *
 * - `httpFor` binds one daemon origin and its confirmed SPKI pin to a
 *   `PinnedHttp` (production passes `createPinnedHttp` over the Kotlin
 *   `pinnedFetch` bridge, which verifies the pin and validity window during
 *   the TLS handshake before the request is written, refuses redirects and
 *   bounds the response at 1 MiB).
 * - `readIdentity` reads the authenticated host identity on the pinned
 *   connection. Production must supply the ticket-authenticated pinned WSS
 *   read (`pinnedSocketOpen`/`Send`/`Close` with `onPinnedSocketEvent`,
 *   exchanging a fresh single-use ticket per attempt); until that reader
 *   exists the screen must stay fail-closed (see below), because redeeming
 *   burns the one-use code.
 *
 * Ordering guarantees, mirroring the iOS `redeemPairing` bridge
 * (`apps/ios/bridge/access.ts`): the pin is validated with `isPin` before
 * the native bridge is touched, so the code never leaves the phone without
 * validated pinning; the code travels only in the POST body, never in a URL
 * (the bound origin is fragment-free by construction). Refusals and HTTP
 * statuses keep the SDK's `ClientError` codes so `pairing-flow.ts` maps them
 * to actionable failures without leaking the code, pin or token.
 *
 * Cancellation: `signal` is honored fail-closed, never as network
 * cancellation. The current native bridge cannot cancel an in-flight pinned
 * request, so an abort only stops waiting on the result: a pre-flight abort
 * throws before the bridge is touched (nothing is sent), while an abort
 * racing the request throws `consumed` — the code may already be burned, so
 * the person must check the computer's devices and create a new link rather
 * than retry a dead one. Wiring true cancellation is an integration gap
 * (see the pairing README).
 */

export interface PinnedHttpBinding {
  readonly origin: string;
  readonly fingerprint: string;
}

export interface PairingTransportDeps {
  httpFor(binding: PinnedHttpBinding): PinnedHttp;
  readIdentity(input: {
    origin: string;
    fingerprint: string;
    signal?: AbortSignal | undefined;
  }): Promise<unknown>;
}

function checkPin(fingerprint: string): void {
  if (!isPin(fingerprint)) {
    throw new PairingFlowError(
      "invalid-link",
      "This link has no valid computer fingerprint, so it can't be verified.",
    );
  }
}

/**
 * Build the confirmed-link transport. Throws `PairingFlowError`
 * (`invalid-link`) before the native bridge is touched when the confirmed
 * pin is malformed, so no secret or one-use code is ever sent unpinned.
 * A pre-flight abort likewise throws before the bridge is touched; an
 * abort racing the request stops waiting only (the bridge cannot cancel)
 * and throws `consumed`, since the one-use code may already be burned.
 */
export function createPairingTransport(deps: PairingTransportDeps): PairingTransport {
  return {
    async redeem(input: {
      origin: string;
      fingerprint: string;
      code: string;
      name: string;
      signal?: AbortSignal | undefined;
    }): Promise<unknown> {
      checkPin(input.fingerprint);
      input.signal?.throwIfAborted();
      const body = JSON.stringify(PairingRedemption.parse({ code: input.code, name: input.name }));
      const http = deps.httpFor({ origin: input.origin, fingerprint: input.fingerprint });
      const pending = accessJson(http, { method: "POST", path: "/v1/pair", body });
      const signal = input.signal;
      if (signal === undefined) return pending;
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(
                new PairingFlowError(
                  "consumed",
                  "Pairing was interrupted after the link may have been used. " +
                    "Check the computer's devices for an unused entry and remove it, then create a new link.",
                ),
              );
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    },
    async readIdentity(input: {
      origin: string;
      fingerprint: string;
      signal?: AbortSignal | undefined;
    }): Promise<unknown> {
      checkPin(input.fingerprint);
      input.signal?.throwIfAborted();
      return deps.readIdentity({
        origin: input.origin,
        fingerprint: input.fingerprint,
        signal: input.signal,
      });
    },
  };
}

async function unavailable(): Promise<never> {
  throw new PairingFlowError("daemon", PAIRING_UNAVAILABLE_MESSAGE);
}

/**
 * Fail-closed transport for builds without the native pairing wiring. Both
 * methods throw before any socket, fetch or credential is touched, so the
 * React Native default WebSocket/fetch can never carry pairing material.
 * The pairing screen disables pairing while this is in effect; the error is
 * preserved verbatim by `pairing-flow.ts` when it is ever called directly.
 */
export function unavailablePairingTransport(): PairingTransport {
  return { redeem: unavailable, readIdentity: unavailable };
}

/** Re-exported for callers that bind the directory entry after redemption. */
export type { ConfirmedPairing };
