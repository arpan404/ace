import { StatusLabel } from "@/components/status-label.tsx";
import { lazy, Suspense } from "react";
const Sessions = lazy(() =>
  import("./past-sessions.tsx").then((module) => ({ default: module.PastSessions })),
);
export function PastSessions(props: { projectId?: string | undefined }) {
  return (
    <Suspense fallback={<StatusLabel tone="working" label="Loading past sessions…" />}>
      <Sessions {...props} />
    </Suspense>
  );
}
