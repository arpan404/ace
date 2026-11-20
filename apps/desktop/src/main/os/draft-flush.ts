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
 * The quit step that keeps the Deck's drafts (docs/editor/workbench.md 50, hot exit): the window
 * is asked to write every pending draft, and the quit waits until it says it has, or until the
 * bound. Quitting never asks the person while drafts can be kept.
 */
export function draftFlush(ports: DraftFlushPorts) {
  let waiting: (() => void) | undefined;
  return {
    /** Resolves once the window flushed its drafts, it has none to ask, or the bound passed. */
    run(): Promise<void> {
      return new Promise<void>((resolve) => {
        let cancel: (() => void) | undefined;
        const done = () => {
          cancel?.();
          if (waiting === done) waiting = undefined;
          resolve();
        };
        waiting = done;
        cancel = ports.timers.set(ports.boundMs ?? draftFlushBoundMs, done);
        if (!ports.ask()) done();
      });
    },
    /** The window wrote its drafts. */
    flushed(): void {
      waiting?.();
    },
  };
}
