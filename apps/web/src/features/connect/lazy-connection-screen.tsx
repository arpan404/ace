import { lazy, Suspense } from "react";

/*
 * The connection screen and its form (TanStack Form, the address schemas) load on demand: a
 * window that already has a daemon never shows them, so they stay out of the first paint. The
 * boot splash covers the moment it takes to load.
 */
const Screen = lazy(() =>
  import("./connection-screen.tsx").then((module) => ({ default: module.ConnectionScreen })),
);

export function ConnectionScreen() {
  return (
    <Suspense fallback={null}>
      <Screen />
    </Suspense>
  );
}
