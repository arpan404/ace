import type { ClientApi } from "@ace/client";
import {
  SuitActive,
  SuitResponse,
  SuitsChanged,
  type SuitDetail,
  type SuitId,
  type SuitRequest,
  type SuitSummary,
} from "@ace/protocol/suits";

export type { SuitActive } from "@ace/protocol/suits";

/*
 * The one place the web app talks to the daemon's Suit library (ADR 0150). Everything else goes
 * through `SuitTransport`. Replies are parsed with the protocol's schemas: they come from
 * outside this process.
 */

/** The raw socket calls: send a Suit request, and hear the list pushed whenever it changes. */
export interface SuitChannel {
  /** The `SuitResponse` the daemon answered with. */
  request(request: SuitRequest, signal?: AbortSignal): Promise<unknown>;
  /**
   * Subscribes to `SuitsChanged`: the current list on every new socket, then each change.
   * `socket` names the socket it came over; the served URLs of an earlier one stop working.
   * Returns the unsubscribe.
   */
  watch(push: (payload: unknown, socket: number) => void, failed: () => void): () => void;
  /** Hears `suitActive` pushes (an agent's `suit_apply`). Returns the unsubscribe. */
  watchActive(push: (payload: unknown) => void): () => void;
  /**
   * The daemon URL a served path (`/v1/suits/...`) is reached at from this page, or undefined
   * when this page can't reach the daemon's HTTP routes (a machine reached through a relay).
   */
  served(path: string): string | undefined;
}

export interface SuitTransport {
  /**
   * Every installed Suit, now and on each change. `socket` changes with each new daemon socket,
   * so details read over an older one are read again. Returns the unsubscribe.
   */
  watch(
    receive: (suits: readonly SuitSummary[], socket?: number) => void,
    failed: () => void,
  ): () => void;
  /** One Suit ready to apply: its manifest and served asset URLs. */
  read(id: SuitId, signal?: AbortSignal): Promise<SuitDetail>;
  /** Each preview, keep or revert an agent makes. Malformed pushes are ignored. */
  watchActive(receive: (active: SuitActive) => void): () => void;
}

export function suitTransport(channel: SuitChannel): SuitTransport {
  return {
    watch(receive, failed) {
      return channel.watch((payload, socket) => {
        const parsed = SuitsChanged.safeParse(payload);
        if (parsed.success) receive(parsed.data.suits, socket);
        else failed();
      }, failed);
    },
    watchActive(receive) {
      return channel.watchActive((payload) => {
        const parsed = SuitActive.safeParse(payload);
        if (parsed.success) receive(parsed.data);
      });
    },
    async read(id, signal) {
      const reply = SuitResponse.safeParse(await channel.request({ op: "read", id }, signal));
      if (!reply.success || reply.data.op !== "read")
        throw new Error("The Suit library answered something else.");
      return reachable(reply.data.suit, channel);
    },
  };
}

/**
 * The detail with its served paths as URLs this page can load. Where the daemon's HTTP routes
 * are out of reach, the Suit applies with its colours alone: no scene, system fonts.
 */
function reachable(detail: SuitDetail, channel: SuitChannel): SuitDetail {
  const assets: SuitDetail["assets"] = {};
  for (const [path, url] of Object.entries(detail.assets)) {
    const served = channel.served(url);
    if (served) assets[path] = served;
  }
  const sceneUrl = detail.sceneUrl === null ? null : (channel.served(detail.sceneUrl) ?? null);
  return { ...detail, sceneUrl, assets };
}

/**
 * The daemon's channel for this client, over its socket (`suitRequest`, `suitsChanged`,
 * `suitActive`). `origin` is the daemon's HTTP origin when this page may dial it directly.
 */
export function daemonSuitChannel(
  client: Pick<ClientApi, "request" | "onMessage" | "connectionGeneration">,
  origin: string | undefined,
): SuitChannel {
  return {
    async request(request, signal) {
      const reply = await client.request(
        { type: "suitRequest", request },
        signal ? { signal } : {},
      );
      return reply.response;
    },
    watch(push, failed) {
      const generation = client.connectionGeneration();
      let socket = generation.getSnapshot();
      let stopped = false;
      const ask = () => {
        const asked = generation.getSnapshot();
        if (asked === undefined) return;
        client.request({ type: "suitRequest", request: { op: "list" } }).then(
          (reply) => {
            if (stopped || generation.getSnapshot() !== asked) return;
            const response = reply.response;
            if (response.op === "list") push({ suits: response.suits }, asked);
            else failed();
          },
          () => {
            if (!stopped && generation.getSnapshot() === asked) failed();
          },
        );
      };
      const stopMessages = client.onMessage((message) => {
        if (message.type !== "suitsChanged") return;
        const current = generation.getSnapshot();
        if (current !== undefined) push({ suits: message.suits }, current);
      });
      // Each new socket lists again: its served URLs carry this daemon run's grants.
      const stopGeneration = generation.subscribe(() => {
        const next = generation.getSnapshot();
        if (next === socket) return;
        socket = next;
        ask();
      });
      ask();
      return () => {
        stopped = true;
        stopMessages();
        stopGeneration();
      };
    },
    watchActive(push) {
      return client.onMessage((message) => {
        if (message.type === "suitActive") push(message.active);
      });
    },
    served(path) {
      if (!origin || !path.startsWith("/v1/suits/")) return undefined;
      return new URL(path, origin).href;
    },
  };
}
