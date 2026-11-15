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

/**
 * Which media connection each source was subscribed on, so its acks follow its pictures, and
 * the poster its subscribe brought back.
 */
export class MediaSubscriptions {
  #route: MediaRoute | undefined;
  #bound = new Map<string, string>();
  #posters = new Map<string, MediaPoster>();
  get route(): MediaRoute | undefined {
    return this.#route;
  }
  use(route: MediaRoute | undefined): void {
    this.#route = route;
    this.reset();
  }
  /** The subscribe's `media` and `codecs` for `source` now, remembering the binding. */
  fields(source: string): { media?: MediaBinding; codecs?: string[] } {
    const binding = this.#route?.binding();
    const codecs = this.#route?.codecs() ?? [];
    if (!binding) {
      this.#bound.delete(source);
      return {};
    }
    this.#bound.set(source, binding.connection);
    return { media: binding, ...(codecs.length ? { codecs: codecs.slice(0, 8) } : {}) };
  }
  /** The subscribe's reply: a poster to show before the first picture. */
  subscribed(source: string, media: MediaSubscribed | undefined): void {
    if (media?.poster && this.#bound.get(source) === media.connection)
      this.#posters.set(source, media.poster);
  }
  poster(source: string): MediaPoster | undefined {
    return this.#posters.get(source);
  }
  /** The source's first live picture came: its poster is done. */
  shown(source: string): void {
    this.#posters.delete(source);
  }
  /** Sends `message` on the media connection when `source` was subscribed on the open one. */
  ack(source: string, message: MediaStreamClientMessage): boolean {
    const bound = this.#bound.get(source);
    const route = this.#route;
    if (!bound || !route || route.binding()?.connection !== bound) return false;
    return route.ack(message);
  }
  forget(source: string): void {
    this.#bound.delete(source);
    this.#posters.delete(source);
  }
  reset(): void {
    this.#bound.clear();
    this.#posters.clear();
  }
}
