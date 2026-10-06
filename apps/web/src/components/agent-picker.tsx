import { useAgent, useAgentTree, type AgentTreeNode } from "@ace/client-react";
import { agentName } from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import { buttonVariants } from "@/components/ui/button.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
} from "@/components/ui/menu.tsx";

/** Each agent of a thread's tree once, parents before their subagents. */
function flatten(nodes: readonly AgentTreeNode[], depth = 0): { id: string; depth: number }[] {
  return nodes.flatMap((node) => [{ id: node.id, depth }, ...flatten(node.children, depth + 1)]);
}

function AgentItem(props: { threadId: string; agentId: string; depth: number; onPick(): void }) {
  const agent = useAgent(props.threadId, props.agentId);
  if (!agent) return null;
  return (
    <MenuItem onClick={props.onPick}>
      <span className={props.depth === 0 ? undefined : props.depth === 1 ? "ps-3" : "ps-6"}>
        {agentName(agent)}
      </span>
    </MenuItem>
  );
}

/**
 * Delegate something a person holds (an app, a device) to one of a thread's agents: a menu of the
 * thread's agent tree. The daemon decides whether that agent may hold it.
 */
export function DelegateMenu(props: {
  threadId: string;
  label?: string;
  disabled?: boolean;
  onDelegate(agentId: string): void;
}) {
  const tree = useAgentTree(props.threadId);
  const agents = flatten(tree ?? []);
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || agents.length === 0}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <RobotIcon aria-hidden size={14} />
        {props.label ?? "Delegate"}
      </MenuTrigger>
      <MenuContent align="end">
        <MenuGroup>
          <MenuLabel>Hand to an agent in this thread</MenuLabel>
          {agents.map((agent) => (
            <AgentItem
              key={agent.id}
              threadId={props.threadId}
              agentId={agent.id}
              depth={agent.depth}
              onPick={() => props.onDelegate(agent.id)}
            />
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/** "Codex" for a holder, from its own thread; a quiet fallback while that thread loads. */
export function useAgentLabel(threadId: string | undefined, agentId: string | undefined): string {
  const agent = useAgent(threadId ?? "", agentId ?? "");
  return agent ? agentName(agent) : "An agent";
}
