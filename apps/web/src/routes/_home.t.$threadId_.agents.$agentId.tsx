import { createFileRoute } from "@tanstack/react-router";
import { SubagentView } from "@/features/thread/index.ts";

/**
 * `/t/<thread>/agents/<agent>`: a provider's own subagent as the whole chat, its transcript
 * from its parent's thread. A subagent ace delegated is a thread of its own, at `/t/<child>`.
 */
export const Route = createFileRoute("/_home/t/$threadId_/agents/$agentId")({
  component: SubagentRoute,
});

function SubagentRoute() {
  const { threadId, agentId } = Route.useParams();
  return <SubagentView key={`${threadId}:${agentId}`} threadId={threadId} agentId={agentId} />;
}
