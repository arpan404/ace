import { MediaSubscriptions, type MediaRoute } from "@ace/browser/live-view";
import type { MediaBinding, MediaStreamClientMessage } from "@ace/protocol";

/*
 * A channel's live views on the phone and the media connection (ADR 0147 §4). Swift asks for each
 * view's subscribe and sends each decoded picture's ack as an action; this decides where they go.
 * A subscribe names the open media connection, when there is one, and the source remembers it:
 * its acks go on that connection while it is still the open one, and by the channel otherwise.
 * Whenever the binding changes (opened, lost, replaced), every watched source subscribes again,
 * so its pictures follow. Without a route, nothing changes from delivery on the channel.
 */
export class MediaViews {
  readonly #media = new MediaSubscriptions();
  readonly #watched = new Set<string>();
  readonly #resubscribe: (source: string) => void;
  #stop: (() => void) | undefined;

  /** `resubscribe` sends a source's subscribe again, built with `subscribe(source)`. */
  constructor(resubscribe: (source: string) => void) {
    this.#resubscribe = resubscribe;
  }
  use(route: MediaRoute | undefined): void {
    this.#stop?.();
    this.#stop = route?.watch(() => {
      for (const source of [...this.#watched]) this.#resubscribe(source);
    });
    this.#media.use(route);
  }
  /** A subscribe for `source` now: where it is delivered. The source is watched from here on. */
  subscribe(source: string): { media?: MediaBinding } {
    this.#watched.add(source);
    const { media } = this.#media.fields(source);
    return media ? { media } : {};
  }
  /** Sends the ack on the media connection the source's pictures come by; false: by the channel. */
  ack(source: string, message: MediaStreamClientMessage): boolean {
    return this.#media.ack(source, message);
  }
  /** The person stopped watching it. */
  forget(source: string): void {
    this.#watched.delete(source);
    this.#media.forget(source);
  }
  /** The channel closed: its subscriptions are gone with it. */
  reset(): void {
    this.#watched.clear();
    this.#media.reset();
  }
}
