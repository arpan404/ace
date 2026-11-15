import type {
  MediaBinding,
  MediaPoster,
  MediaStreamClientMessage,
  MediaSubscribed,
} from "@ace/protocol";
import type { StreamMessage } from "./stream.ts";
import type { PictureChunk } from "./stream-picture.ts";
import { DeliveryCandidates } from "./delivery-candidates.ts";

/**
 * A client's media connection as a live-view channel sees it (ADR 0147 §4): what to name in a
 * subscribe, the pictures that arrive on it and where acks go. The screen and device channels
 * take one, so their pictures can come by ace-media while their state and requests stay on the
 * channel. Without one, or while it has no binding, everything stays on the channel.
 */
export interface MediaRoute {
  /** The binding a subscribe names now; absent: deliver on the channel. */
  binding(): MediaBinding | undefined;
  /** The decoders to name with a binding, best first. */
  codecs(): readonly string[];
  /** Called whenever `binding()` changes: every held stream subscribes again. */
  watch(listener: () => void): () => void;
  onStream(listener: (message: StreamMessage) => void): () => void;
  /** Sends on the media connection; false when it can't, and the ack goes by the channel. */
  ack(message: MediaStreamClientMessage): boolean;
}

/** A subscribe the daemon refused for naming a media connection that isn't this session's. */
export const isMediaRefusal = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("media-connection");

/** The codec every viewer decodes, kept when a source has given up on the others. */
const baseline = "avc1.42E033";
/** A codec's family: `hvc1` and `hev1` are both HEVC, every `avc1` is H.264. */
const family = (codec: string) => {
  const head = codec.slice(0, 4);
  return head === "hev1" ? "hvc1" : head;
};

/** Where a picture came from, or goes back to: the channel itself (legacy delivery). */
export const channelPath = "channel";

/** How an ack for a picture travels: the media connection, the channel, or nowhere (stale). */
export type AckWay = "media" | "channel" | "stale";

/** One subscribe of one source: its generation, what it named, and what the daemon answered. */
interface Delivery {
  generation: number;
  /** The connection the subscribe named; undefined: none (the channel). */
  asked: string | undefined;
  /** The reply's answer: that connection, or `channelPath`; undefined until it comes. */
  via: string | undefined;
}

/**
 * Each source's deliveries, one generation per subscribe (ADR 0147 §4). Every subscribe opens a
 * generation; its reply or refusal is matched to it, and one a later subscribe superseded changes
 * nothing. Every picture is stamped with its source's generation as it arrives, and only when it
 * came the way that generation expects (the connection it named, else the channel); acks for an
 * older generation are dropped, never sent through the current one. A subscribe the daemon
 * refused, or answered without `media`, stays on the channel; a refused connection isn't named
 * again for the source until the binding changes. Also the poster the subscribe brought back, and
 * the codecs each source's viewer couldn't decode.
 */
export class MediaSubscriptions {
  #route: MediaRoute | undefined;
  /** Generations count up across sources and resets, so an old one never matches again. */
  #next = 0;
  #deliveries = new Map<string, Delivery>();
  /** Refused for this source: not named again while it is the binding. */
  #refused = new Map<string, string>();
  #posters = new Map<string, MediaPoster>();
  /** Pictures that came while a subscribe naming a connection waits for its reply. */
  #candidates = new Map<string, DeliveryCandidates<PictureChunk>>();
  /**
   * Codec families a source's viewer couldn't decode: that source alone asks without them. Kept
   * across reconnects of the channel, and dropped with the route.
   */
  #failed = new Map<string, Set<string>>();
  get route(): MediaRoute | undefined {
    return this.#route;
  }
  use(route: MediaRoute | undefined): void {
    this.#route = route;
    this.#failed.clear();
    this.reset();
  }
  /**
   * A new subscribe of `source`: its generation, and its `media` and `codecs`. Everything of the
   * source's earlier generations is stale from here on.
   */
  begin(source: string): {
    generation: number;
    fields: { media?: MediaBinding; codecs?: string[] };
  } {
    const binding = this.#route?.binding();
    const codecs = this.codecs(source);
    const generation = ++this.#next;
    this.#posters.delete(source);
    this.#candidates.delete(source);
    const asked =
      binding && this.#refused.get(source) !== binding.connection ? binding.connection : undefined;
    this.#deliveries.set(source, { generation, asked, via: undefined });
    if (!binding || !asked) return { generation, fields: {} };
    return {
      generation,
      fields: { media: binding, ...(codecs.length ? { codecs: codecs.slice(0, 8) } : {}) },
    };
  }
  /** The decoders `source`'s subscribe names: the route's, less what failed for this source. */
  codecs(source: string): string[] {
    const offered = this.#route?.codecs() ?? [];
    const failed = this.#failed.get(source);
    if (!failed) return offered.slice(0, 8);
    const left = offered.filter((codec) => !failed.has(family(codec)));
    return (left.length ? left : [baseline]).slice(0, 8);
  }
  /**
   * `source`'s viewer couldn't decode `codec`. True when that takes something away (anything but
   * H.264, the baseline): subscribe that source again, and the others keep their codecs.
   */
  fallBack(source: string, codec: string): boolean {
    const lost = family(codec);
    if (lost === "avc1") return false;
    const failed = this.#failed.get(source) ?? new Set<string>();
    if (failed.has(lost)) return false;
    failed.add(lost);
    this.#failed.set(source, failed);
    return true;
  }
  /**
   * The reply to `generation`'s subscribe: delivery by the media connection only when it names
   * the one asked for. A reply to a superseded subscribe changes nothing.
   */
  subscribed(source: string, generation: number, media: MediaSubscribed | undefined): Settled {
    const delivery = this.#current(source, generation);
    if (!delivery) return { pictures: [] };
    const bound = delivery.asked !== undefined && media?.connection === delivery.asked;
    const via = bound && delivery.asked ? delivery.asked : channelPath;
    delivery.via = via;
    if (bound && media?.poster) this.#posters.set(source, media.poster);
    // What came the settled way while the reply was on its way shows now; the rest is dropped.
    const held = this.#candidates.get(source)?.settle(via);
    this.#candidates.delete(source);
    return {
      pictures: (held?.pictures ?? []).map((frame) => ({ frame, generation })),
      ...(held?.needsKeyframe && held.ask ? { ask: { frame: held.ask, generation } } : {}),
    };
  }
  /**
   * `generation`'s subscribe got no answer in time. While it is still the current one and
   * unsettled, nothing more is held for it: delivery falls back to the channel, and what was
   * held is dropped. A late reply (`subscribed` with the same generation) still settles it.
   */
  abandon(source: string, generation: number): void {
    const delivery = this.#current(source, generation);
    if (!delivery || delivery.via !== undefined) return;
    delivery.via = channelPath;
    this.#candidates.delete(source);
  }
  /**
   * `generation`'s subscribe failed. True when it is still the current one, had named a media
   * connection and was refused for it: subscribe again, and it goes on the channel.
   */
  refused(source: string, generation: number, error: unknown): boolean {
    const delivery = this.#current(source, generation);
    if (!delivery?.asked || !isMediaRefusal(error)) return false;
    this.#refused.set(source, delivery.asked);
    return true;
  }
  /**
   * A picture of `source` arrived by `path` (`channelPath`, or a media connection): it stamped
   * with its generation to show now, or undefined. Undefined while a subscribe naming a connection
   * waits for its reply (it is held as a candidate, released by `subscribed`), and when it didn't
   * come the way the current subscribe expects (it belongs to an earlier one: dropped).
   */
  arrive(source: string, path: string, frame: PictureChunk): Stamped | undefined {
    const delivery = this.#deliveries.get(source);
    // No subscribe of its own (a still, or a stream held before media): the channel's, as ever.
    if (!delivery) return path === channelPath ? { frame, generation: 0 } : undefined;
    if (delivery.via === undefined && delivery.asked !== undefined) {
      // Unsettled: it may come either way until the reply says which. Held, not shown yet.
      if (path === delivery.asked || path === channelPath) {
        let held = this.#candidates.get(source);
        if (!held) this.#candidates.set(source, (held = new DeliveryCandidates()));
        held.hold(path, frame);
      }
      return undefined;
    }
    return expected(delivery) === path ? { frame, generation: delivery.generation } : undefined;
  }
  /** Whether a picture stamped `generation` is still `source`'s; unstamped counts as current. */
  current(source: string, generation: number | undefined): boolean {
    if (generation === undefined) return true;
    return (this.#deliveries.get(source)?.generation ?? 0) === generation;
  }
  /** How the ack for `source`'s picture stamped `generation` travels. */
  way(source: string, generation: number | undefined): AckWay {
    if (!this.current(source, generation)) return "stale";
    const delivery = this.#deliveries.get(source);
    const path = delivery ? expected(delivery) : channelPath;
    if (path === channelPath) return "channel";
    // An unstamped ack is a client that predates generations: it may only speak for the channel.
    if (generation === undefined) return "stale";
    // Its connection closed since: nothing of it can be acked anywhere else.
    return this.#route?.binding()?.connection === path ? "media" : "stale";
  }
  poster(source: string): MediaPoster | undefined {
    return this.#posters.get(source);
  }
  forget(source: string): void {
    this.#deliveries.delete(source);
    this.#candidates.delete(source);
    this.#refused.delete(source);
    this.#posters.delete(source);
  }
  reset(): void {
    this.#deliveries.clear();
    this.#candidates.clear();
    this.#refused.clear();
    this.#posters.clear();
  }
  #current(source: string, generation: number): Delivery | undefined {
    const delivery = this.#deliveries.get(source);
    return delivery?.generation === generation ? delivery : undefined;
  }
}

/**
 * What a reply settles: the pictures held for it, to show now, and, when the buffer overflowed,
 * the keyframe to ask a fresh one in the name of (on the settled way).
 */
export interface Settled {
  pictures: Stamped[];
  ask?: Stamped;
}

/** A picture to show, with the generation of the subscribe it was delivered for. */
export interface Stamped {
  frame: PictureChunk;
  generation: number;
}

/** The way a delivery's pictures come: its answer, or before it, what it asked for. */
const expected = (delivery: Delivery): string => delivery.via ?? delivery.asked ?? channelPath;
