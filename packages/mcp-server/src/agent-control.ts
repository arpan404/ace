import { agentTools } from "./agent-tools.ts";
import { automationTools } from "./automation-tools.ts";
import type { AgentControlPort, ControlTool } from "./control-tool.ts";
import { offshift } from "./offshift-tools.ts";
import { threadControl } from "./thread-control-tool.ts";
import { threadTools } from "./thread-tools.ts";
import type { Toolkit } from "./toolkits.ts";

export type { AgentControlPort } from "./control-tool.ts";
export { maxDelegateTasks } from "./agent-tools.ts";

/**
 * Agents, threads and automations: each tool translates its input into the daemon's
 * agent-control operations, which own authorization, ownership and durability.
 */
export const agentControlToolCatalog: readonly ControlTool[] = [
  ...agentTools,
  ...threadTools,
  threadControl,
  offshift,
  ...automationTools,
];

/** ace's own tools a provider should still gate itself: the rest never prompt there. */
export const destructiveAceTools: readonly string[] = agentControlToolCatalog
  .filter((definition) => definition.destructive)
  .map((definition) => definition.name);

export function agentControlToolkit(port: AgentControlPort): Toolkit {
  return {
    register(registry) {
      for (const tool of agentControlToolCatalog) tool.register(registry, port);
    },
  };
}
