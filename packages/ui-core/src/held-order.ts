/*
 * A list that holds still while the person is working in it (UX audit TN-3): while a row has
 * keyboard focus or a drag is under way, rows keep their places; the new order applies a moment
 * after both end. The pointer merely resting on the list never holds it. Pure order logic plus a
 * small state machine; the caller passes the timers.
 */

/**
 * `next`'s rows in the order `shown` drew them. Rows in both keep their places, unless `free`
 * lets one go; free rows and new rows go where `next` puts them, right after the row before
 * them there (or first). Rows gone from `next` leave. Each row drawn is `next`'s copy.
 */
export function holdOrder<T>(
  shown: readonly T[],
  next: readonly T[],
  keyOf: (row: T) => string,
  free: (row: T, was: T) => boolean,
): T[] {
  if (!shown.length) return [...next];
  const was = new Map(shown.map((row) => [keyOf(row), row]));
  const latest = new Map(next.map((row) => [keyOf(row), row]));
  const held = (row: T) => {
    const before = was.get(keyOf(row));
    return before !== undefined && !free(row, before);
  };
  const placed: T[] = [];
  for (const row of shown) {
    const current = latest.get(keyOf(row));
    if (current !== undefined && held(current)) placed.push(current);
  }
  let previous: string | undefined;
  for (const row of next) {
    const key = keyOf(row);
    if (!held(row)) {
      const after = previous === undefined ? -1 : placed.findIndex((r) => keyOf(r) === previous);
      placed.splice(after + 1, 0, row);
    }
    previous = key;
  }
  return placed;
}

/** Runs `callback` after `delayMs`; the result cancels it. */
export interface Timers {
  set(delayMs: number, callback: () => void): () => void;
}

export interface Hold {
  /** Keep the order drawn now. */
  held: boolean;
  /** A row that needs you may still rise: no drag is under way. */
  rise: boolean;
}

/** How long after keyboard focus leaves the list, or a drag ends, its new order applies. */
export const holdReleaseMs = 600;

const free: Hold = { held: false, rise: true };

/**
 * Whether a list holds its order. It holds while keyboard focus is in it or a drag is under way,
 * and for `releaseMs` after both have ended. A React view reads it with
 * `useSyncExternalStore`.
 */
export class ListHold {
  private dragging = false;
  private focused = false;
  private settling: (() => void) | undefined;
  private state: Hold = free;
  private listeners = new Set<() => void>();
  private timers: Timers;
  private releaseMs: number;
  constructor(timers: Timers, releaseMs = holdReleaseMs) {
    this.timers = timers;
    this.releaseMs = releaseMs;
  }
  getState = (): Hold => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** A drag in the list began (true) or ended (false). */
  drag(active: boolean): void {
    this.dragging = active;
    this.update();
  }
  /** Keyboard focus came into the list (true) or left it (false). */
  focus(within: boolean): void {
    this.focused = within;
    this.update();
  }
  /** Let go at once and cancel a pending release, as when the list goes away. */
  dispose(): void {
    this.settling?.();
    this.settling = undefined;
    this.dragging = false;
    this.focused = false;
    this.set(free);
  }
  private update(): void {
    const looking = this.dragging || this.focused;
    if (looking) {
      this.settling?.();
      this.settling = undefined;
    } else if (this.state.held && !this.settling) {
      this.settling = this.timers.set(this.releaseMs, () => {
        this.settling = undefined;
        this.set(free);
      });
    }
    if (looking || this.settling) this.set({ held: true, rise: !this.dragging });
  }
  private set(next: Hold): void {
    if (next.held === this.state.held && next.rise === this.state.rise) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
