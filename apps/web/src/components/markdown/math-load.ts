/*
 * Loading the KaTeX chunk, shared by every formula and the idle warm-up.
 *
 * A failed load is never remembered: the next formula to mount, or the next
 * warm-up, tries again (a dev server re-optimizing its deps or a flaky link
 * fails one import, not the session). Formulas whose load failed show their
 * source as plain prose and subscribe here, so the first load that succeeds
 * renders all of them at once.
 */

type Loader = () => Promise<unknown>;

const defaultLoader: Loader = () => import("./math-katex.ts");
let loader: Loader = defaultLoader;
let pending: Promise<boolean> | undefined;
let loaded = false;
const listeners = new Set<() => void>();

/** Load KaTeX once; resolves `false` (never rejects) when this attempt failed. */
export function loadMath(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  pending ??= loader().then(
    () => {
      loaded = true;
      for (const listener of listeners) listener();
      return true;
    },
    () => {
      pending = undefined;
      return false;
    },
  );
  return pending;
}

/** Called once a later load succeeds; returns an unsubscribe. */
export function onMathLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests substitute the chunk import; `undefined` restores the real one and resets state. */
export function setMathLoader(next: Loader | undefined): void {
  loader = next ?? defaultLoader;
  pending = undefined;
  loaded = false;
}
