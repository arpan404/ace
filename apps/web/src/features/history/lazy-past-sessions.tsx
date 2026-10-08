import { lazy, Suspense } from "react";
const Sessions = lazy(() =>
  import("./past-sessions.tsx").then((module) => ({ default: module.PastSessions })),
);
export function PastSessions(props: { projectId?: string | undefined }) {
  return (
    <Suspense fallback={null}>
      <Sessions {...props} />
    </Suspense>
  );
}
