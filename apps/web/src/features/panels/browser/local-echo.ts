/**
 * Local echo for the live page: what the person's own input should look like before the page's
 * next frame shows it. Pure: the shell (`use-local-echo.ts`) owns timers, frames and the DOM.
 */

interface PendingScroll {
  id: number;
  /** The page's scroll change asked for, in page pixels (positive scrolls down or right). */
  x: number;
  y: number;
  /** The page took it; the next frame shows it. */
  dispatched: boolean;
}

/**
 * Scrolls sent but not yet in a frame, as one offset to draw the last frame at: while a scroll
 * is in flight the frame moves at once by what it will move, and a frame that shows the scroll
 * takes its share of the offset away, so the picture settles without a jump. Immutable: every
 * change returns a new echo, so it can be held as view state.
 */
export class ScrollEcho {
  private readonly pending: readonly PendingScroll[];

  constructor(pending: readonly PendingScroll[] = []) {
    this.pending = pending;
  }

  /** A scroll went to the page, by `x`, `y` page pixels; `id` names it for the calls below. */
  sent(id: number, x: number, y: number): ScrollEcho {
    return new ScrollEcho([...this.pending, { id, x, y, dispatched: false }]);
  }

  /** The page has the scroll (its input request answered); the next frame shows it. */
  dispatched(id: number): ScrollEcho {
    if (!this.pending.some((pending) => pending.id === id)) return this;
    return new ScrollEcho(
      this.pending.map((pending) =>
        pending.id === id ? { ...pending, dispatched: true } : pending,
      ),
    );
  }

  /** The page refused or lost the scroll, or never showed it: it stops moving the frame. */
  dropped(id: number): ScrollEcho {
    if (!this.pending.some((pending) => pending.id === id)) return this;
    return new ScrollEcho(this.pending.filter((pending) => pending.id !== id));
  }

  /** A new frame arrived: every scroll the page had by then is in it. */
  framed(): ScrollEcho {
    if (!this.pending.some((pending) => pending.dispatched)) return this;
    return new ScrollEcho(this.pending.filter((pending) => !pending.dispatched));
  }

  /**
   * Where to draw the last frame, in page pixels: opposite to the pending scroll (scrolling
   * down moves the picture up), clamped so it never slides further than `limit` either way.
   */
  offset(limit: { x: number; y: number }): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const pending of this.pending) {
      x += pending.x;
      y += pending.y;
    }
    return { x: clamp(-x, limit.x), y: clamp(-y, limit.y) };
  }

  /** Nothing is in flight. */
  get idle(): boolean {
    return this.pending.length === 0;
  }
}

function clamp(value: number, limit: number): number {
  const bound = Math.max(0, limit);
  // `|| 0` folds -0 into 0, so an idle echo is exactly no offset.
  return Math.min(bound, Math.max(-bound, value)) || 0;
}

/**
 * The input round trip shown in the ⋯ menu: a moving average, so one slow request moves it
 * a little and a lasting change shows within a few. The first sample is taken as it is.
 */
export function nextLatency(previous: number | undefined, sample: number): number {
  if (!Number.isFinite(sample) || sample < 0) return previous ?? 0;
  if (previous === undefined) return sample;
  return previous + (sample - previous) * 0.25;
}

/** CSS cursor keywords a page may set; anything else is drawn as the default arrow. */
const cursorKeywords = new Set([
  "auto",
  "default",
  "none",
  "context-menu",
  "help",
  "pointer",
  "progress",
  "wait",
  "cell",
  "crosshair",
  "text",
  "vertical-text",
  "alias",
  "copy",
  "move",
  "no-drop",
  "not-allowed",
  "grab",
  "grabbing",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
]);

/**
 * The person's own pointer over the page, drawn by their system at display rate in the page's
 * cursor shape (a CSS keyword the page reported). Unknown or missing shapes are the arrow.
 */
export function localCursor(shape: string | undefined): string {
  const keyword = shape?.trim().toLowerCase();
  if (!keyword || keyword === "auto") return "default";
  return cursorKeywords.has(keyword) ? keyword : "default";
}
