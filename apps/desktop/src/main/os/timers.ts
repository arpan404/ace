/**
 * Real timers for the main process. They live in a module so that `main()`, which runs
 * during `index.ts`'s top-level code, never reads them before they are initialized.
 */
export const timers = {
  set(delayMs: number, callback: () => void): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
