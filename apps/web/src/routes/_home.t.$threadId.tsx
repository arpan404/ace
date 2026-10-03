import { createFileRoute } from "@tanstack/react-router";
import { ThreadView } from "@/features/thread/thread-view.tsx";

export const Route = createFileRoute("/_home/t/$threadId")({ component: ThreadRoute });

function ThreadRoute() {
  const { threadId } = Route.useParams();
  return <ThreadView key={threadId} threadId={threadId} />;
}
