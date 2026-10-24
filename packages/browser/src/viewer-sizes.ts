/** A size a person's viewer gave a thread's page (`resize` from their connection). */
export interface ViewerSize {
  width: number;
  height: number;
  /** The viewer is on a touch screen: the page lays out as a phone's or tablet's. */
  touch: boolean;
  devicePixelRatio?: number | undefined;
}

/**
 * Which viewer's size a thread's page shows. Each person's connection that sizes the page is
 * remembered, and the most recent one wins. When that viewer leaves (it stops watching or its
 * connection drops), the page goes back to the previous viewer's size. When the last one leaves
 * and it was a touch screen, the page goes back to the last desktop size it had, so a phone
 * that walked away does not leave the page laid out as a phone.
 */
export class ViewerSizes {
  /** Insertion order is recency: the last entry is the size the page shows. */
  #sizes = new Map<string, ViewerSize>();
  /** The last size a non-touch viewer gave, or the page's own before any viewer sized it. */
  #resting: { width: number; height: number } | undefined;

  /** `connectionId` sized the page; `current` is its size before this one applied. */
  record(connectionId: string, size: ViewerSize, current: { width: number; height: number }) {
    if (!this.#sizes.size && !this.#resting) this.#resting = { ...current };
    if (!size.touch) this.#resting = { width: size.width, height: size.height };
    this.#sizes.delete(connectionId);
    this.#sizes.set(connectionId, { ...size });
  }

  /** `connectionId` left: the size to apply now, when the page showed theirs. */
  release(connectionId: string): ViewerSize | undefined {
    const latest = this.#latest();
    const left = this.#sizes.get(connectionId);
    if (!left) return undefined;
    this.#sizes.delete(connectionId);
    if (latest !== left) return undefined;
    const next = this.#latest();
    if (next) return { ...next };
    const resting = this.#resting;
    if (!left.touch || !resting) return undefined;
    return { ...resting, touch: false };
  }

  #latest(): ViewerSize | undefined {
    let last: ViewerSize | undefined;
    for (const size of this.#sizes.values()) last = size;
    return last;
  }
}
