import { ChannelClose, MachineCodeRefusal } from "@ace/protocol";
import { relayGrant, type Credential } from "./credentials.ts";
import { ephemeralRelayKeys } from "./device-route.ts";
import { relayCompression } from "./inflate.ts";
import { AceAccountError } from "./ace-account.ts";
import { NOT_YOUR_MACHINE_CLOSE } from "@ace/account-grant";
import { RelayClosedError } from "./relay-closed.ts";
import { RELAY_EARLY } from "./relay-early.ts";
export { RELAY_EARLY } from "./relay-early.ts";
import type { PortableRelay, PortableRelayOptions, PortableSocket } from "./portable-relay.ts";
import { ClientError, type Transport } from "./types.ts";

/**
 * Close code a relay route reports when the daemon asked an account device for its machine
 * code, or refused the one sent (ADR 0111). The connection stops (`ClientError` code
 * `machine_code`, message the refusal) until the person enters the code and it starts again.
 */
export const MACHINE_CODE_CLOSE = 4011;

export interface RelayRouteOptions {
  /** The relay's WebSocket address (`wss://…`). */
  relayUrl: string;
  /** The host key to pin: the machine's relay host id (its base32 fingerprint). */
  hostId: string;
  /**
   * A fresh credential for each connection attempt: a one-use ticket, or an account device
   * grant (five minutes) with the machine code once the person typed it. A grant is offered
   * to the relay as its subprotocol and sent again in the hello.
   */
  credential(): Promise<Credential>;
  socket(url: string, protocols?: string[]): PortableSocket;
  schedule(callback: () => void, delayMs: number): () => void;
  keys?: PortableRelayOptions["keys"];
  /** The daemon wants this machine's code, or refused the one sent (`machineCodeGate.refused`). */
  refused?(reason: MachineCodeRefusal, message: string, lockedUntil?: number): void;
  /** The daemon welcomed this attempt (`machineCodeGate.welcomed`). */
  welcomed?(): void;
  /**
   * A grant the relay most likely refused (`ClientOptions.grantRefused`). A browser can't tell a
   * relay refusing a grant at the WebSocket upgrade from a dropped link, so it is named only
   * after two attempts in a row that offered that same grant failed before their WebSocket
   * opened. An attempt whose upgrade succeeded resets the count, however it ends after.
   */
  grantRefused?(grant: string): boolean;
}

/** How a close or failure before welcome reads, for the connection's retry rules. */
function credentialClose(error: unknown): [number, string] {
  if (
    (error instanceof ClientError && error.code === "auth") ||
    (error instanceof AceAccountError && error.status === 401)
  )
    return [4001, "Credential refused"];
  return [1006, "Credential unavailable"];
}

/**
 * The main conversation through a relay: a `Transport` and the `credential` that goes with
 * it, for `ClientOptions`. Each attempt fetches its own credential, dials the relay (offering a
 * grant as the subprotocol), runs the pinned handshake, and hands the connection that same
 * credential for its hello. Bulk JSON may come deflated. The daemon's `channel.close` becomes
 * the transport's close code, so revocation, idle and resync closes read as on a direct socket.
 */
export function relayRoute(options: RelayRouteOptions): {
  transport(): Transport;
  credential(): Promise<Credential>;
} {
  let pending: Credential | undefined;
  /**
   * This relay said it holds an early frame (ADR 0155, step 1), so a dial without a grant may
   * offer to send early: memory only, for this route's life.
   */
  let earlyKnown = false;
  /**
   * An upgrade carrying the first message failed before it opened and the same dial without it
   * opened (a relay or proxy that won't take the larger header): this route no longer carries it
   * there, for its life (ADR 0155).
   */
  let upgradeRefused = false;
  /** The grant the last attempt offered, when the relay failed before opening for it. */
  let unopened: string | undefined;
  /** An attempt offering `grant` failed before its WebSocket opened: twice in a row names it. */
  const upgradeFailed = (grant: string | undefined) => {
    if (grant === undefined) return;
    if (unopened !== grant) {
      unopened = grant;
      return;
    }
    unopened = undefined;
    options.grantRefused?.(grant);
  };
  return {
    async credential() {
      const credential = pending;
      pending = undefined;
      if (!credential) throw new ClientError("auth", "No relay credential for this attempt");
      return credential;
    },
    transport() {
      let relay: PortableRelay | undefined;
      let controller: AbortController | undefined;
      let epoch = 0;
      /** The credential this transport's own attempt opened with, for its hello. */
      let own: Credential | undefined;
      const stop = () => {
        epoch++;
        controller?.abort();
        controller = undefined;
        relay?.close();
        relay = undefined;
      };
      return {
        supportsBinary: true,
        compression: relayCompression(),
        flowControl: ["credit"],
        // Several attempts on one route at once (a race and a side path) each send their own.
        async credential() {
          const credential = own;
          own = undefined;
          if (!credential) throw new ClientError("auth", "No relay credential for this attempt");
          return credential;
        },
        open(events) {
          stop();
          const stamp = ++epoch;
          const signal = (controller = new AbortController()).signal;
          const ended = (code: number, reason: string) => {
            if (stamp !== epoch) return;
            stop();
            events.close(code, reason);
          };
          void (async () => {
            let credential: Credential;
            try {
              credential = await options.credential();
            } catch (error) {
              ended(...credentialClose(error));
              return;
            }
            if (stamp !== epoch) return;
            const { connectPortableRelay } = await import("./portable-relay.ts");
            const grant = relayGrant(credential);
            /** The WebSocket upgrade succeeded: what fails after it says nothing of the grant. */
            let upgraded = false;
            // Offer to send early only where any relay answers something offered: with a grant
            // (an older relay echoes it), or to a relay that said it is new.
            const early = grant !== undefined || earlyKnown;
            const dial = (sendEarly: boolean, inUpgrade = false) =>
              connectPortableRelay({
                relayUrl: options.relayUrl,
                pinnedFingerprint: options.hostId,
                socket: (url, protocols) => {
                  const socket = options.socket(url, protocols);
                  socket.addEventListener("open", () => {
                    upgraded = true;
                    unopened = undefined;
                  });
                  return socket;
                },
                grant,
                keys: options.keys ?? ephemeralRelayKeys,
                schedule: options.schedule,
                signal,
                early: sendEarly,
                inUpgrade,
              });
            let opened: PortableRelay;
            try {
              // The first message rides in the upgrade wherever early sending is offered: with a
              // grant, or to a relay that said it is new. Both answer something offered whether
              // or not they know ace.v2, so the offer can't fail an upgrade they would accept.
              const inUpgrade = early && !upgradeRefused;
              try {
                opened = await dial(early, inUpgrade);
              } catch (error) {
                if (stamp !== epoch) throw error;
                const lost =
                  error instanceof RelayClosedError && error.code === RELAY_EARLY.lostClose;
                if (inUpgrade && !upgraded) {
                  // Refused before it opened, maybe for its header: once more at once without
                  // the message in it, and not again on this route. This failure doesn't count
                  // toward naming the grant refused; the retry's does.
                  upgradeRefused = true;
                  try {
                    opened = await dial(early);
                  } catch (retried) {
                    // Refused without it too: the header wasn't why. Offer it again next time.
                    if (!upgraded) upgradeRefused = false;
                    throw retried;
                  }
                } else if (early && lost)
                  // The hosted relay lost the held frame: once more at once, after the marker.
                  opened = await dial(false);
                else throw error;
              }
            } catch (error) {
              // Only an upgrade that failed may be the relay refusing the grant; a failure of
              // this attempt, not one the connection called off.
              if (stamp === epoch && !upgraded) upgradeFailed(grant);
              // A relay that took the early offer before but not now may be an older one again.
              if (stamp === epoch && !upgraded && grant === undefined) earlyKnown = false;
              throw error;
            }
            earlyKnown = opened.earlyCapable === true;
            unopened = undefined;
            if (stamp !== epoch) {
              opened.close();
              return;
            }
            relay = opened;
            pending = credential;
            own = credential;
            events.open();
            let welcomed = false;
            const current = () => stamp === epoch;
            while (current()) {
              const frame = await opened.receiveRaw();
              if (!current()) return;
              if (typeof frame !== "string") {
                events.binary?.(frame);
                continue;
              }
              // The daemon writes `type` first; only these frames are looked at here.
              if (frame.startsWith('{"type":"channel.close"')) {
                const goodbye = ChannelClose.parse(JSON.parse(frame));
                ended(goodbye.code, goodbye.reason);
                return;
              }
              if (!welcomed) {
                if (frame.startsWith('{"type":"welcome"')) {
                  welcomed = true;
                  options.welcomed?.();
                } else if (frame.startsWith('{"type":"error"')) {
                  const refusal = machineCodeRefusal(frame);
                  if (refusal) {
                    options.refused?.(refusal.reason, refusal.message, refusal.lockedUntil);
                    ended(MACHINE_CODE_CLOSE, refusal.reason);
                    return;
                  }
                }
              }
              events.message(frame);
            }
          })().catch((error: unknown) =>
            // The relay's own "not your machine" is final; anything else is a drop to retry.
            error instanceof RelayClosedError && error.code === NOT_YOUR_MACHINE_CLOSE
              ? ended(NOT_YOUR_MACHINE_CLOSE, error.message)
              : ended(1006, "Relay channel closed"),
          );
        },
        send(text) {
          const current = relay;
          if (!current) throw new Error("Relay channel is not open");
          // The connection bounds what it sends; this only keeps the relay's own queue bound.
          void current.sendText(text, 16 * 1024 * 1024).catch(() => {});
        },
        close: stop,
      };
    },
  };
}

function machineCodeRefusal(
  frame: string,
): { reason: MachineCodeRefusal; message: string; lockedUntil?: number } | undefined {
  try {
    const value: unknown = JSON.parse(frame);
    if (typeof value !== "object" || value === null) return undefined;
    const reason = MachineCodeRefusal.safeParse("code" in value ? value.code : undefined);
    if (!reason.success) return undefined;
    const message = "message" in value && typeof value.message === "string" ? value.message : "";
    const until = "lockedUntil" in value ? value.lockedUntil : undefined;
    return {
      reason: reason.data,
      message,
      ...(typeof until === "number" ? { lockedUntil: until } : {}),
    };
  } catch {
    return undefined;
  }
}
