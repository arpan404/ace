import { lazy, Suspense } from "react";
const Sessions = lazy(() =>
  import("./past-sessions.tsx").then((module) => ({ default: module.PastSessions })),
);
const SelectedSessions = lazy(() =>
  import("./past-sessions.tsx").then((module) => ({ default: module.ProjectPastSessions })),
);
export function ProjectPastSessions(props: { projectId: string | undefined }) {
  return (
    <Suspense fallback={null}>
      <SelectedSessions {...props} />
    </Suspense>
  );
}
export function PastSessions() {
  return (
    <Suspense fallback={null}>
      <Sessions />
    </Suspense>
  );
}
