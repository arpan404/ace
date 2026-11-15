import type { MediaRoute, SourcePicture } from "@ace/browser/live-view";

/*
 * A screen or devices channel's live streams as the phone's views hold them (ADR 0147 §4). The
 * shared channel client owns everything about delivery: each held stream's subscribe, whether it
 * names the media connection and whether the daemon confirmed it, subscribing again when the
 * binding changes or a connection is refused, and sending each ack where its pictures came from.
 * Swift's pictures never reach JavaScriptCore, so its acks arrive here as numbers and go through
 * the client's own `ack`.
 */

/** What this needs of `ScreenStreamClient` and `DeviceClient`. */
export interface StreamChannel {
  retainStream(source: string): () => void;
  useMedia(route: MediaRoute | undefined): void;
  ack(picture: SourcePicture, keyframe?: boolean): void;
}

const h264 = ["avc1.42E033"];

export class HeldStreams {
  readonly #channel: StreamChannel;
  readonly #held = new Map<string, () => void>();
  /** A decoder failed on a better codec: this channel's views ask for H.264 from here on. */
  #h264Only = false;
  constructor(channel: StreamChannel) {
    this.#channel = channel;
  }
  /** Pictures by this media connection while it has a binding, in the codecs the phone decodes. */
  useMedia(route: MediaRoute | undefined): void {
    this.#channel.useMedia(
      route && { ...route, codecs: () => (this.#h264Only ? h264 : route.codecs()) },
    );
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
  /** Swift decoded up to `sequence`; `keyframe`: its decoder lost its place. */
  ack(source: string, streamId: string, sequence: number, keyframe: boolean): void {
    this.#channel.ack(decoded(source, streamId, sequence), keyframe);
  }
  /** The decoder couldn't play the codec: every held stream subscribes again for H.264. */
  fallBack(): void {
    if (this.#h264Only) return;
    this.#h264Only = true;
    for (const source of [...this.#held.keys()]) this.hold(source);
  }
}

/** A live picture Swift decoded, as the channel's ack reads it: its source, stream and sequence. */
function decoded(sourceId: string, streamId: string, sequence: number): SourcePicture {
  return {
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
