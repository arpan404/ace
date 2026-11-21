import type { DeliveryState, MediaRoute, SourcePicture } from "@ace/browser/live-view";

/*
 * A screen or devices channel's live streams as the phone's views hold them (ADR 0147 §4). The
 * shared channel client owns everything about delivery: each held stream's subscribe, whether it
 * names the media connection and whether the daemon confirmed it, subscribing again when the
 * binding changes or a connection is refused, and sending each ack by the media connection.
 * Swift's pictures never reach JavaScriptCore, so its acks arrive here as numbers and go through
 * the client's own `ack`.
 */

/** What this needs of `ScreenStreamClient` and `DeviceClient`. */
export interface StreamChannel {
  retainStream(source: string): () => void;
  useMedia(route: MediaRoute | undefined): void;
  ack(picture: SourcePicture, keyframe?: boolean): void;
  /** The view of `source` couldn't decode `codec`: that stream alone asks again without it. */
  fallBack(source: string, codec: string): boolean;
  /** Whether `picture` is of its source's current subscribe. */
  current(picture: SourcePicture): boolean;
  watchDeliveries(listener: (state: DeliveryState) => void): () => void;
}

/** Tells Swift a source's delivery (`PhoneMedia.deliver`), for its view. */
export type DeliverNatively = (view: "screen" | "device", state: DeliveryState) => void;

export class HeldStreams {
  readonly #channel: StreamChannel;
  readonly #held = new Map<string, () => void>();
  readonly #view: "screen" | "device";
  #stopDeliveries: (() => void) | undefined;
  constructor(channel: StreamChannel, view: "screen" | "device") {
    this.#channel = channel;
    this.#view = view;
  }
  /** Pictures by this media connection while it has a binding, in the codecs the phone decodes. */
  useMedia(route: MediaRoute | undefined, deliver?: DeliverNatively): void {
    this.#channel.useMedia(route);
    // Swift draws and acknowledges each source's pictures by the delivery the client sets.
    this.#stopDeliveries?.();
    this.#stopDeliveries = deliver
      ? this.#channel.watchDeliveries((state) => deliver(this.#view, state))
      : undefined;
  }
  /**
   * A view watches `source`: its stream is held until `release`. Swift asks again whenever its
   * view comes back (the app foregrounded, the channel reconnected), so holding it again
   * subscribes it again rather than counting a second hold.
   */
  hold(source: string): void {
    this.release(source);
    this.#held.set(source, this.#channel.retainStream(source));
  }
  release(source: string): void {
    this.#held.get(source)?.();
    this.#held.delete(source);
  }
  /** The channel closed: its streams went with it. */
  clear(): void {
    this.#held.clear();
  }
  /**
   * Swift decoded up to `sequence`; `keyframe`: its decoder lost its place. `generation` is the
   * delivery its picture came for, so the client sends the ack that way, or drops it as stale.
   */
  ack(
    source: string,
    streamId: string,
    sequence: number,
    keyframe: boolean,
    generation?: number,
  ): void {
    this.#channel.ack(decoded(source, streamId, sequence, generation), keyframe);
  }
  /**
   * Swift's decoder couldn't play `codec` for `source`: that stream asks again without it, unless
   * the failure was in the decoder of an earlier delivery (`generation`), which says nothing now.
   */
  fallBack(source: string, codec: string, generation?: number): void {
    if (!this.#channel.current(decoded(source, "", 0, generation))) return;
    this.#channel.fallBack(source, codec);
  }
}

/** A live picture Swift decoded, as the channel's ack reads it: its source, stream and sequence. */
function decoded(
  sourceId: string,
  streamId: string,
  sequence: number,
  generation: number | undefined,
): SourcePicture {
  return {
    ...(generation === undefined ? {} : { generation }),
    sourceId,
    streamId,
    sequence,
    timestamp: 0,
    width: 0,
    height: 0,
    scale: 1,
    rotation: 0,
    codec: "",
    key: false,
    bytes: new Uint8Array(0),
  };
}
