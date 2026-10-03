import { lazy, type ComponentType } from "react";

/**
 * A component whose code loads after the first paint. Its first render before the code has
 * loaded suspends, like `React.lazy`; once `preload()` (or that first render) has loaded it, it
 * renders synchronously, so warming it while the browser is idle means nobody waits for it.
 */
export function deferredComponent<P extends object>(load: () => Promise<ComponentType<P>>): {
  Component: ComponentType<P>;
  preload(): Promise<unknown>;
} {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (loading ??= load().then((component) => {
      loaded = component;
      return component;
    }));
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Deferred(props: P) {
    // Reads module state that changes once, when the code arrives; nothing to memoise.
    "use no memo";
    const Component = loaded ?? Lazy;
    return <Component {...props} />;
  }
  return { Component: Deferred, preload };
}
