import type {
  MediaBinding,
  MediaPoster,
  MediaStreamClientMessage,
  MediaSubscribed,
  MediaUndelivered,
} from "@ace/protocol";
import type { StreamMessage } from "./stream.ts";
import type { PictureChunk } from "./stream-picture.ts";
import { DeliveryCandidates, type CandidateShape } from "./delivery-candidates.ts";

/**
 * A client's media connection as a live-view channel sees it (ADR 0147 §4): what to name in a
 * subscribe, the pictures that arrive on it and where acks go. The screen and device channels
 * take one, so their pictures come by ace-media while their state and requests stay on the
 * channel. Only ace-media delivers live pictures (X3): without a binding, a view gets none and
 * says why.
 */
export interface MediaRoute {
  /** The binding a subscribe names now; absent: no media connection, so no pictures. */
  binding(): MediaBinding | undefined;
  /** The decoders to name with a binding, best first. */
  codecs(): readonly string[];
  /** Called whenever `binding()` changes: every held stream subscribes again. */
  watch(listener: () => void): () => void;
  onStream(listener: (message: StreamMessage) => void): () => void;
  /** Sends on the media connection; false when it can't (the ack has nowhere else to go). */
  ack(message: MediaStreamClientMessage): boolean;
  /** Why there is no binding now, for the person; absent: it is still connecting. */
  unavailable?(): string | undefined;
}

/**
 * How long a subscribe naming a media connection may wait for its reply before its source stops
 * waiting and says so; a later reply still settles it.
 */
export const mediaSubscribeDeadlineMs = 15_000;

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

/**
 * Where a picture came from: the channel itself. Only stills (a person's screenshot) come this
 * way since X3; a live picture on it belongs to no delivery and is dropped.
 */
export const channelPath = "channel";
/** A delivery nobody serves: no pictures come, and `undelivered` says why. */
export const nonePath = "none";

/**
 * How an ack for a picture travels: the media connection, or nowhere (stale). `channel` is
 * never answered since X3 (the daemon sends no live pictures there); it stays in the type
 * until every client stops naming it.
 */
export type AckWay = "media" | "channel" | "stale";

/** One subscribe of one source: its generation, what it named, and what the daemon answered. */
interface Delivery {
  generation: number;
  /** The connection the subscribe named; undefined: none (no binding). */
  asked: string | undefined;
  /** The reply's answer: that connection, or `nonePath`; undefined until it comes. */
  via: string | undefined;
  /** Why no pictures come, once `via` is `nonePath`. */
  undelivered?: MediaUndelivered;
  /**
   * Why its pictures haven't come yet though it may deliver: the daemon's word that its source
   * isn't streaming, or what the delivery it replaced said. The first picture on it clears this,
   * so a picture kept from before never passes for a live one meanwhile.
   */
  waiting?: MediaUndelivered;
}

/** Waits before a failed subscribe is tried again, by attempt; then the source gives up. */
export const mediaRetryDelaysMs = [1_000, 2_000, 5_000, 10_000] as const;

/**
 * Once the retries are spent, how long a source waits before it is tried again. Nothing skips
 * it: not a page shown again, nor an agent opening the browser.
 */
export const mediaRetryCooldownMs = 30_000;

/** What a failed subscribe leaves to do: subscribe again now, later, or nothing. */
export type FailedSubscribe = "resubscribe" | "retry" | "ignore";

/** Why a view without a binding gets nothing, when its route doesn't say. */
const connecting: MediaUndelivered = {
  code: "connecting",
  reason: "Connecting to live video…",
};
/** A subscribe that got no answer in time. */
const unanswered: MediaUndelivered = {
  code: "timeout",
  reason: "Live video didn't answer. ace tries again shortly.",
};
/** A subscribe that failed, and kept no delivery from before. */
const failedSubscribe: MediaUndelivered = {
  code: "failed",
  reason: "Live video couldn't start. ace tries again shortly.",
};

/**
 * A source's current delivery, for a viewer whose pictures arrive outside this client (a native
 * decoder): its generation, the way its pictures come (a media connection, or `nonePath` with
 * why), or undefined while the subscribe's reply is pending, and the poster accepted for it.
 */
export interface DeliveryState {
  source: string;
  generation: number;
  path: string | undefined;
  /** The still this subscribe's reply brought back, accepted for it, until its first picture. */
  poster?: MediaPoster;
  /** Why no pictures come, while `path` is `nonePath`. */
  undelivered?: MediaUndelivered;
}

/**
 * Each source's deliveries, one generation per subscribe (ADR 0147 §4). Every subscribe opens a
 * generation; its reply, refusal, failure or timeout is matched to it, and one a later subscribe
 * superseded changes nothing. Every picture is stamped with its source's generation as it
 * arrives, and only when it came on the connection that generation named; while a subscribe
 * naming a connection waits for its reply, its pictures are held as candidates, bounded, and the
 * reply releases them. Acks for an older generation are dropped, never sent through the current
 * one.
 *
 * Only ace-media delivers (X3). A subscribe answered without `media` (ace-media can't serve it,
 * or this client had no binding to name) gets no pictures: its delivery is `nonePath`, and
 * `undelivered` says why, the daemon's reason or, without a binding, the route's own.
 *
 * - A subscribe refused for its connection is tried again (`retry`), and that connection isn't
 *   named again for the source until the binding changes.
 * - A subscribe that fails otherwise keeps the delivery it replaced when that connection is
 *   still the binding (the daemon regrants the old view); either way it is tried again on
 *   `mediaRetryDelaysMs`.
 * - A subscribe that gets no answer in time (`abandon`) says so; its late reply still settles it.
 *
 * Shared by the screen and device channels (pictures) and the browser's view (video chunks).
 * Also the poster each subscribe brought back, and the codecs each source's viewer couldn't
 * decode.
 */
export class MediaSubscriptions<F extends CandidateShape = PictureChunk> {
  #route: MediaRoute | undefined;
  #deliveryListeners = new Set<(state: DeliveryState) => void>();
  /** Generations count up across sources and resets, so an old one never matches again. */
  #next = 0;
  #deliveries = new Map<string, Delivery>();
  /** The settled delivery a pending subscribe replaced: kept again if that subscribe fails. */
  #previous = new Map<string, Delivery>();
  /** Failed subscribes in a row, per source, for the retry delay. */
  #attempts = new Map<string, number>();
  /** Subscribes in a row answered without delivery, per source, for `unservedDelay`. */
  #unserved = new Map<string, number>();
  /** Refused for this source: not named again while it is the binding. */
  #refused = new Map<string, string>();
  #posters = new Map<string, MediaPoster>();
  /** Pictures that came while a subscribe naming a connection waits for its reply. */
  #candidates = new Map<string, DeliveryCandidates<F>>();
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
    fields: { media?: MediaBinding; codecs?: string[]; mediaClient: true };
  } {
    const binding = this.#route?.binding();
    const codecs = this.codecs(source);
    const generation = ++this.#next;
    this.#posters.delete(source);
    this.#candidates.delete(source);
    const replaced = this.#deliveries.get(source);
    if (replaced?.via !== undefined) this.#previous.set(source, replaced);
    const asked =
      binding && this.#refused.get(source) !== binding.connection ? binding.connection : undefined;
    // A retry keeps saying why the last one got nothing, until a picture comes on this one.
    const waiting = replaced && reasonOf(replaced);
    this.#deliveries.set(source, {
      generation,
      asked,
      via: undefined,
      ...(waiting ? { waiting } : {}),
    });
    this.#emit(source);
    // Every subscribe says this client takes pictures only from a media connection.
    if (!binding || !asked) return { generation, fields: { mediaClient: true } };
    return {
      generation,
      fields: {
        media: binding,
        ...(codecs.length ? { codecs: codecs.slice(0, 8) } : {}),
        mediaClient: true,
      },
    };
  }
  /** The generation of `source`'s current subscribe, if it has one. */
  generation(source: string): number | undefined {
    return this.#deliveries.get(source)?.generation;
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
   * the one asked for; otherwise none, and why (`undelivered`, or the route's own reason when
   * the subscribe named no connection). A reply to a superseded subscribe changes nothing.
   */
  subscribed(
    source: string,
    generation: number,
    media: MediaSubscribed | undefined,
    undelivered?: MediaUndelivered,
  ): Settled<F> {
    const delivery = this.#current(source, generation);
    if (!delivery) return { pictures: [] };
    const bound = delivery.asked !== undefined && media?.connection === delivery.asked;
    const via = bound && delivery.asked ? delivery.asked : nonePath;
    delivery.via = via;
    if (bound) {
      delete delivery.undelivered;
      this.#unserved.delete(source);
    }
    // Without a binding, this client knows better than the daemon why: it named none.
    else delivery.undelivered = delivery.asked ? (undelivered ?? failedSubscribe) : this.#why();
    this.#previous.delete(source);
    this.#attempts.delete(source);
    if (bound && media?.poster) this.#posters.set(source, media.poster);
    // What came the settled way while the reply was on its way shows now; the rest is dropped.
    const held = this.#candidates.get(source)?.settle(via);
    this.#candidates.delete(source);
    // Pictures already came on it: nothing it was waiting for still holds.
    if (bound && held?.pictures.length) delete delivery.waiting;
    this.#emit(source);
    return {
      pictures: (held?.pictures ?? []).map((frame) => ({ frame, generation })),
      ...(held?.needsKeyframe && held.ask ? { ask: { frame: held.ask, generation } } : {}),
    };
  }
  /**
   * `generation`'s subscribe got no answer in time. While it is still the current one and
   * unsettled, nothing more is held for it: the view says so, and what was held is dropped. A
   * late reply (`subscribed` with the same generation) still settles it.
   */
  abandon(source: string, generation: number): void {
    const delivery = this.#current(source, generation);
    if (!delivery || delivery.via !== undefined) return;
    delivery.via = nonePath;
    delivery.undelivered = unanswered;
    this.#previous.delete(source);
    this.#candidates.delete(source);
    this.#emit(source);
  }
  /**
   * `generation`'s subscribe failed with `error`. Unless a later subscribe superseded it, or a
   * timeout already settled it, nothing more is held for it, and it is to be tried again
   * (`retry`, after `retryDelay`):
   * - refused for the connection it named: that connection isn't named again for the source
   *   until the binding changes;
   * - otherwise the delivery it replaced is kept when its connection is still the binding, else
   *   the view gets no pictures and says why.
   */
  failed(source: string, generation: number, error: unknown): FailedSubscribe {
    const delivery = this.#current(source, generation);
    if (!delivery || delivery.via !== undefined) return "ignore";
    this.#candidates.delete(source);
    if (delivery.asked && isMediaRefusal(error)) this.#refused.set(source, delivery.asked);
    const previous = this.#previous.get(source);
    this.#previous.delete(source);
    const holds =
      previous?.via !== undefined &&
      previous.via !== nonePath &&
      previous.via === this.#route?.binding()?.connection;
    if (previous && holds) this.#deliveries.set(source, previous);
    else {
      delivery.via = nonePath;
      delivery.undelivered = failedSubscribe;
    }
    // The delivery it replaced, back again, or none: either way, its way is known now.
    this.#emit(source);
    return "retry";
  }
  /**
   * Its retries are spent: the connection bound now isn't named for `source` again until the
   * binding changes, so its next subscribe names none (and says why).
   */
  giveUp(source: string): void {
    const connection = this.#route?.binding()?.connection;
    if (connection) this.#refused.set(source, connection);
  }
  /**
   * How long until a source whose subscribe was answered without delivery (ace-media couldn't
   * serve it, or there was no connection to name) asks again: the ladder's steps, then the
   * cooldown, for as long as it isn't delivered. Its source may become available at any time,
   * so it never gives up, and it names the connection each time.
   */
  unservedDelay(source: string): number {
    const attempt = this.#unserved.get(source) ?? 0;
    this.#unserved.set(source, attempt + 1);
    return mediaRetryDelaysMs[attempt] ?? mediaRetryCooldownMs;
  }
  /** How long until a failed source is tried again; undefined once the retries are spent. */
  retryDelay(source: string): number | undefined {
    const attempt = this.#attempts.get(source) ?? 0;
    const delay = mediaRetryDelaysMs[attempt];
    if (delay !== undefined) this.#attempts.set(source, attempt + 1);
    return delay;
  }
  /**
   * A picture of `source` arrived by `path` (`channelPath`, or a media connection): it stamped
   * with its generation to show now, or undefined. Undefined while a subscribe naming a connection
   * waits for its reply (it is held as a candidate, released by `subscribed`), and when it didn't
   * come on the connection the current subscribe named (an earlier one's, or the channel's).
   */
  arrive(source: string, path: string, frame: F): Stamped<F> | undefined {
    const delivery = this.#deliveries.get(source);
    // No subscribe of its own: only a still (a person's screenshot) comes this way.
    if (!delivery) return path === channelPath ? { frame, generation: 0 } : undefined;
    if (delivery.via === undefined && delivery.asked !== undefined) {
      // Unsettled: held until the reply says whether it delivers, not shown yet.
      if (path === delivery.asked) {
        let held = this.#candidates.get(source);
        if (!held) this.#candidates.set(source, (held = new DeliveryCandidates<F>()));
        held.hold(path, frame);
      }
      return undefined;
    }
    if (delivered(delivery) !== path) return undefined;
    // A picture on the current delivery: whatever said it was waiting no longer holds.
    if (delivery.waiting) {
      delete delivery.waiting;
      this.#emit(source);
    }
    return { frame, generation: delivery.generation };
  }
  /** Whether what comes by `path` for `source` (sound, say) is its current delivery's. */
  expects(source: string, path: string): boolean {
    const delivery = this.#deliveries.get(source);
    if (!delivery) return false;
    if (delivery.via === undefined && delivery.asked !== undefined) return false;
    return delivered(delivery) === path;
  }
  /** Whether a picture stamped `generation` is still `source`'s; unstamped counts as current. */
  current(source: string, generation: number | undefined): boolean {
    if (generation === undefined) return true;
    return (this.#deliveries.get(source)?.generation ?? 0) === generation;
  }
  /** How the ack for `source`'s picture stamped `generation` travels. */
  way(source: string, generation: number | undefined): AckWay {
    // An unstamped ack is a still's, or a client that predates generations: nothing to ack.
    if (generation === undefined || !this.current(source, generation)) return "stale";
    const delivery = this.#deliveries.get(source);
    const path = delivery ? delivered(delivery) : undefined;
    // Its connection closed since: nothing of it can be acked anywhere else.
    return path !== undefined && this.#route?.binding()?.connection === path ? "media" : "stale";
  }
  poster(source: string): MediaPoster | undefined {
    return this.#posters.get(source);
  }
  /**
   * Whether `source`'s subscribe named a connection and ace-media couldn't serve it: it asks
   * again on `unservedDelay`. One that named none waits for a binding instead (`watch`).
   */
  unserved(source: string): boolean {
    const delivery = this.#deliveries.get(source);
    return delivery?.via === nonePath && delivery.asked !== undefined;
  }
  /**
   * Why `source`'s current delivery gets no pictures, or hasn't yet: undefined once a picture
   * came on it, or while nothing says otherwise.
   */
  undelivered(source: string): MediaUndelivered | undefined {
    const delivery = this.#deliveries.get(source);
    return delivery && reasonOf(delivery);
  }
  /**
   * The daemon's word on `source`'s bound view (`*.delivery`): why its source isn't streaming
   * into ace-media now, or undefined once it is. Pictures that then come clear it too.
   */
  report(source: string, undelivered: MediaUndelivered | undefined): void {
    const delivery = this.#deliveries.get(source);
    if (!delivery || delivery.via === nonePath) return;
    if (undelivered) delivery.waiting = undelivered;
    else delete delivery.waiting;
    this.#emit(source);
  }
  /**
   * `source`'s delivery ends (its stream invalidated): whatever its pending subscribe still gets
   * changes nothing, and what was held for it goes. What it refused and its retries stay.
   */
  end(source: string): void {
    this.#deliveries.delete(source);
    this.#previous.delete(source);
    this.#candidates.delete(source);
    this.#posters.delete(source);
  }
  forget(source: string): void {
    this.end(source);
    this.#refused.delete(source);
    this.#attempts.delete(source);
    this.#unserved.delete(source);
  }
  reset(): void {
    this.#deliveries.clear();
    this.#previous.clear();
    this.#attempts.clear();
    this.#unserved.clear();
    this.#candidates.clear();
    this.#refused.clear();
    this.#posters.clear();
  }
  /**
   * Hears each change of a source's delivery: a new subscribe (pending while it named a
   * connection), the way its reply settled on, the channel when it got none in time, and the
   * delivery a failed subscribe fell back to (which may be an earlier generation's, again).
   */
  watchDeliveries(listener: (state: DeliveryState) => void): () => void {
    this.#deliveryListeners.add(listener);
    return () => void this.#deliveryListeners.delete(listener);
  }
  /** Why a subscribe that named no connection gets nothing: the route's word, or connecting. */
  #why(): MediaUndelivered {
    const reason = this.#route?.unavailable?.();
    return reason ? { code: "unavailable", reason } : connecting;
  }
  #emit(source: string): void {
    const delivery = this.#deliveries.get(source);
    if (!delivery) return;
    // Unsettled only while a named connection's reply is on its way; otherwise its way is known.
    const pending = delivery.via === undefined && delivery.asked !== undefined;
    const poster = this.#posters.get(source);
    const undelivered = reasonOf(delivery);
    const state = {
      source,
      generation: delivery.generation,
      path: pending ? undefined : delivered(delivery),
      ...(poster ? { poster } : {}),
      ...(undelivered ? { undelivered } : {}),
    };
    // A copy: a listener may stop listening while it hears this.
    for (const listener of Array.from(this.#deliveryListeners)) listener(state);
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
export interface Settled<F = PictureChunk> {
  pictures: Stamped<F>[];
  ask?: Stamped<F>;
}

/** A picture to show, with the generation of the subscribe it was delivered for. */
export interface Stamped<F = PictureChunk> {
  frame: F;
  generation: number;
}

/**
 * The way a delivery's pictures come: its answer, or before it, what it asked for; a subscribe
 * that named nothing gets nothing.
 */
const delivered = (delivery: Delivery): string => delivery.via ?? delivery.asked ?? nonePath;

/** Why a delivery gets no pictures (`nonePath`), or none yet (`waiting`). */
const reasonOf = (delivery: Delivery): MediaUndelivered | undefined =>
  delivery.via === nonePath ? delivery.undelivered : delivery.waiting;
