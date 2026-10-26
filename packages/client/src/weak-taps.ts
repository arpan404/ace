import { notifyObservers, type ChangeTap } from "./observable.ts";

/** What a weak relay listens to: a store's change feed. */
export interface ChangeFeed {
  observe(tap: ChangeTap): () => void;
}

/** A dropped owner's relay leaves the feed once its taps are collected. */
const relays = new FinalizationRegistry<() => void>((stop) => stop());

/**
 * Taps on a long-lived feed, held only as long as their owner holds this object (or an
 * unsubscribe it returned). The feed keeps one relay, which reaches the taps through a weak
 * reference: a cache keyed by a short-lived owner (a jumped window's ledger or turn tree) that
 * observes it for its life and never unsubscribes can no longer keep the owner and everything it
 * reads alive through the feed, nor run on every change after the owner is gone.
 */
export class WeakTaps {
  readonly #taps = new Set<ChangeTap>();
  readonly #feed: ChangeFeed;
  readonly #filter: (keys: ReadonlySet<string>) => ReadonlySet<string>;
  #stop: (() => void) | undefined;

  /** `filter` narrows each change to the keys the owner's taps see; an empty result is skipped. */
  constructor(feed: ChangeFeed, filter: (keys: ReadonlySet<string>) => ReadonlySet<string>) {
    this.#feed = feed;
    this.#filter = filter;
  }

  add(tap: ChangeTap): () => void {
    if (!this.#stop) {
      this.#stop = WeakTaps.#relay(this.#feed, new WeakRef(this.#taps), this.#filter);
      relays.register(this.#taps, this.#stop, this.#taps);
    }
    // Its own function per call: unsubscribing twice must not drop another identical tap.
    const own: ChangeTap = (keys) => tap(keys);
    this.#taps.add(own);
    return () => {
      if (!this.#taps.delete(own) || this.#taps.size) return;
      relays.unregister(this.#taps);
      this.#stop?.();
      this.#stop = undefined;
    };
  }

  /** The feed's tap: it captures the weak reference and the filter, never the owner. */
  static #relay(
    feed: ChangeFeed,
    target: WeakRef<Set<ChangeTap>>,
    filter: (keys: ReadonlySet<string>) => ReadonlySet<string>,
  ): () => void {
    let stop: (() => void) | undefined;
    stop = feed.observe((keys) => {
      const taps = target.deref();
      if (!taps) return stop?.();
      if (keys === "all") return notifyObservers(taps, keys);
      const visible = filter(keys);
      if (visible.size) notifyObservers(taps, visible);
    });
    return stop;
  }
}
