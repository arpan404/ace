/**
 * Longest a quit waits for the window to keep its unsaved editor text on the device: an
 * IndexedDB write of a few drafts takes milliseconds, so this only bounds a hung renderer.
 */
export const draftFlushBoundMs = 2_000;

export interface DraftFlushPorts {
  /** Asks the window to write its pending drafts; false when there is no live window to ask. */
  ask(): boolean;
  timers: { set(delayMs: number, callback: () => void): () => void };
  boundMs?: number;
}

/**
 * The quit's check that keeps the Deck's drafts (docs/editor/workbench.md 50, hot exit): the
 * window is asked to write every pending draft, and the quit waits until it says whether they
 * are kept, or until the bound. Quitting asks the person only when the window could not keep
 * them (storage full or unavailable); the window asks, so the quit stops.
 */
export function draftFlush(ports: DraftFlushPorts) {
  let waiting: ((kept: boolean) => void) | undefined;
  return {
    /**
     * True once the window kept its drafts, has none to ask, or the bound passed (a hung window
     * never holds a quit); false when it couldn't keep them and the quit should stop.
     */
    run(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        let cancel: (() => void) | undefined;
        const done = (kept: boolean) => {
          cancel?.();
          if (waiting === done) waiting = undefined;
          resolve(kept);
        };
        waiting = done;
        cancel = ports.timers.set(ports.boundMs ?? draftFlushBoundMs, () => done(true));
        if (!ports.ask()) done(true);
      });
    },
    /** The window wrote its drafts: `kept` false when the device couldn't store them. */
    flushed(kept: boolean): void {
      waiting?.(kept);
    },
  };
}
