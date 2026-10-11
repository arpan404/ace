import { lazy, type ComponentType } from "react";

/** Carries recovery for a failed code load to the boundary that caught it. */
export class DeferredLoadError extends Error {
  readonly retry: () => void;

  constructor(cause: unknown, retry: () => void) {
    super(cause instanceof Error ? cause.message : "Couldn't load this view.", { cause });
    this.name = "DeferredLoadError";
    this.retry = retry;
  }
}

/**
 * A component whose code loads after the first paint. Its first render before the code has
 * loaded suspends, like `React.lazy`; once `preload()` (or that first render) has loaded it, it
 * renders synchronously, so warming it while the browser is idle means nobody waits for it.
 */
export function deferredComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
): {
  Component: ComponentType<P>;
  preload(): Promise<unknown>;
} {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (cause: unknown) => {
        loading = undefined;
        throw new DeferredLoadError(cause, () => {
          // React.lazy retains rejected loads too; a boundary retry needs a fresh instance.
          Lazy = makeLazy();
        });
      },
    ));
  const makeLazy = () => lazy(() => preload().then((component) => ({ default: component })));
  let Lazy = makeLazy();
  function Deferred(props: P) {
    // Reads module state that changes once, when the code arrives; nothing to memoise.
    "use no memo";
    const Component = loaded ?? Lazy;
    return <Component {...props} />;
  }
  return { Component: Deferred, preload };
}
