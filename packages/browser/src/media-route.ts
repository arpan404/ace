import type {
  MediaBinding,
  MediaPoster,
  MediaStreamClientMessage,
  MediaSubscribed,
} from "@ace/protocol";
import type { StreamMessage } from "./stream.ts";

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

/**
 * Which media connection each source's subscribe named and the daemon confirmed, so its acks
 * follow its pictures, and the poster that subscribe brought back. A subscribe the daemon
 * refused, or answered without `media` (ace-media doesn't deliver that kind now), stays on the
 * channel; a refused connection isn't named again until the binding changes.
 */
export class MediaSubscriptions {
  #route: MediaRoute | undefined;
  /** Named in the subscribe in flight, not yet confirmed. */
  #asked = new Map<string, string>();
  /** Confirmed by the subscribe's reply. */
  #bound = new Map<string, string>();
  /** Refused for this source: not named again while it is the binding. */
  #refused = new Map<string, string>();
  #posters = new Map<string, MediaPoster>();
  get route(): MediaRoute | undefined {
    return this.#route;
  }
  use(route: MediaRoute | undefined): void {
    this.#route = route;
    this.reset();
  }
  /** The subscribe's `media` and `codecs` for `source` now. */
  fields(source: string): { media?: MediaBinding; codecs?: string[] } {
    const binding = this.#route?.binding();
    const codecs = this.#route?.codecs() ?? [];
    this.#bound.delete(source);
    if (!binding || this.#refused.get(source) === binding.connection) {
      this.#asked.delete(source);
      return {};
    }
    this.#asked.set(source, binding.connection);
    return { media: binding, ...(codecs.length ? { codecs: codecs.slice(0, 8) } : {}) };
  }
  /** The subscribe's reply: delivery by the media connection only when it says so. */
  subscribed(source: string, media: MediaSubscribed | undefined): void {
    const asked = this.#asked.get(source);
    this.#asked.delete(source);
    if (!asked || media?.connection !== asked) return void this.#bound.delete(source);
    this.#bound.set(source, asked);
    if (media.poster) this.#posters.set(source, media.poster);
  }
  /**
   * The subscribe failed. True when it had named a media connection and was refused for it:
   * subscribe again, and it goes on the channel.
   */
  refused(source: string, error: unknown): boolean {
    const asked = this.#asked.get(source);
    this.#asked.delete(source);
    if (!asked || !isMediaRefusal(error)) return false;
    this.#refused.set(source, asked);
    return true;
  }
  poster(source: string): MediaPoster | undefined {
    return this.#posters.get(source);
  }
  /** Sends `message` on the media connection when `source` was confirmed on the open one. */
  ack(source: string, message: MediaStreamClientMessage): boolean {
    const bound = this.#bound.get(source);
    const route = this.#route;
    if (!bound || !route || route.binding()?.connection !== bound) return false;
    return route.ack(message);
  }
  forget(source: string): void {
    this.#asked.delete(source);
    this.#bound.delete(source);
    this.#refused.delete(source);
    this.#posters.delete(source);
  }
  reset(): void {
    this.#asked.clear();
    this.#bound.clear();
    this.#refused.clear();
    this.#posters.clear();
  }
}
