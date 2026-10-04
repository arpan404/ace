import { useAgent } from "@ace/client-react";
import { glyphOf, isRunning } from "@ace/ui-core";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { AgentStatusMark } from "./agent-status.tsx";

/**
 * An agent tab's live mark in the strip: spinner while it works, a dot when it needs you or
 * failed. Folded to the tab's icon, only the dot stays.
 */
export function AgentBadge(props: { scope: string; tab: WorkspaceTab; folded?: boolean }) {
  const agent = useAgent(props.scope, props.tab.id);
  if (!agent || !(isRunning(agent) || agent.status.state === "failed")) return null;
  if (props.folded && !["failed", "needs-you"].includes(glyphOf(agent.status))) return null;
  return <AgentStatusMark status={agent.status} />;
}
