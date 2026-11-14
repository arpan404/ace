import type { ClientApi } from "@ace/client";
import {
  SuitDetail,
  SuitsChanged,
  type SuitId,
  type SuitRequest,
  type SuitSummary,
} from "@ace/protocol/suits";

/*
 * The one place the web app talks to the daemon's Suit library (ADR 0150). Everything else goes
 * through `SuitTransport`, so wiring the socket is a change to `daemonSuitChannel` alone.
 * Replies are parsed with the protocol's schemas: they come from outside this process.
 */

/** The raw socket calls: send a Suit request, and hear the list pushed whenever it changes. */
export interface SuitChannel {
  request(request: SuitRequest, signal?: AbortSignal): Promise<unknown>;
  /** Subscribes to `SuitsChanged`; the first push is the current list. Returns the unsubscribe. */
  watch(push: (payload: unknown) => void, failed: () => void): () => void;
}

export interface SuitTransport {
  /** Every installed Suit, now and on each change. Returns the unsubscribe. */
  watch(receive: (suits: readonly SuitSummary[]) => void, failed: () => void): () => void;
  /** One Suit ready to apply: its manifest and served asset URLs. */
  read(id: SuitId, signal?: AbortSignal): Promise<SuitDetail>;
}

export function suitTransport(channel: SuitChannel): SuitTransport {
  return {
    watch(receive, failed) {
      return channel.watch((payload) => {
        const parsed = SuitsChanged.safeParse(payload);
        if (parsed.success) receive(parsed.data.suits);
        else failed();
      }, failed);
    },
    async read(id, signal) {
      const reply = await channel.request({ op: "read", id }, signal);
      const parsed = SuitDetail.safeParse(reply);
      if (!parsed.success) throw new Error("The Suit library answered something else.");
      return parsed.data;
    },
  };
}

/**
 * The daemon's channel for this client. The client protocol has no Suit messages yet (the
 * daemon side is being built), so there is none: Suits then list as empty and the chosen theme
 * shows. Once `suits.request` / `suits.changed` exist, build the channel from `client` here.
 */
export function daemonSuitChannel(_client: ClientApi): SuitChannel | undefined {
  return undefined;
}
