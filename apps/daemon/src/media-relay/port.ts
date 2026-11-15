import type { FromMedia } from "@ace/media/wire";
import { keyPair, type KeyPair } from "@ace/secure-channel";
import { randomUUID } from "node:crypto";
import { systemMediaClock } from "@ace/media/supervisor";
import type { MediaTicketClaim } from "./admit.ts";
import { MediaRelayStreams, type MediaRelayLink } from "./streams.ts";

/** Hears ace-media's messages and exits. */
export type MediaRelayWatcher = {
  message(message: FromMedia, payload: Uint8Array): void;
  exit(): void;
};

/** What the daemon's ace-media offers relay streams, once its runtime exists. */
export type MediaRelayPort = MediaRelayLink & {
  claim: MediaTicketClaim;
  /** ace-media's messages and exits, from now on, until the returned unsubscribe. */
  watch(watcher: MediaRelayWatcher): () => void;
};

/**
 * The relay host's media streams, bound late: the relay connects while the daemon starts, and
 * ace-media's runtime appears only once a media setting turns `auto`. Until then (or while the
 * port says it isn't available) every media ticket is turned down and the client falls back.
 */
export function lateMediaRelay(
  port: () => MediaRelayPort | undefined,
  options: { hostKeys: KeyPair; log?: (line: string) => void },
): { streams: MediaRelayStreams; claim: MediaTicketClaim } {
  let watched: MediaRelayPort | undefined;
  let unwatch: (() => void) | undefined;
  let streams: MediaRelayStreams | undefined;
  const watcher: MediaRelayWatcher = {
    message: (message, payload) => streams?.onMessage(message, payload),
    exit: () => streams?.onExit(),
  };
  // One watcher at a time: a new runtime's port replaces the last one's.
  const current = () => {
    const live = port();
    if (live && watched !== live) {
      unwatch?.();
      watched = live;
      unwatch = live.watch(watcher);
    }
    return live;
  };
  streams = new MediaRelayStreams({
    link: {
      send(message, payload = new Uint8Array(0)) {
        const live = current();
        if (live) return live.send(message, payload);
        payload.fill(0);
        return false;
      },
      closeStream: (message) => current()?.closeStream(message),
      need: () => current()?.need() ?? (() => {}),
      available: () => current()?.available() === true,
    },
    clock: systemMediaClock,
    hostKeys: options.hostKeys,
    ephemeralKey: keyPair,
    newId: randomUUID,
    log: options.log ?? (() => {}),
  });
  return { streams, claim: (ticket, claimant) => current()?.claim(ticket, claimant) };
}
