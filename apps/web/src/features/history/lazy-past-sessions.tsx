import { lazy, Suspense } from "react";
const Sessions = lazy(() =>
  import("./past-sessions.tsx").then((module) => ({ default: module.PastSessions })),
);
export function PastSessions() {
  return (
    <Suspense fallback={null}>
      <Sessions />
    </Suspense>
  );
}
