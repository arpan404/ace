import type { ThreadReader } from "@ace/client";
import { arrayEqual, useAgent, useThread } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { useCallback, type CSSProperties } from "react";
import { agentName, modelLine, providerNames } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";

const activities: Record<string, string> = {
  thinking: "Thinking",
  responding: "Writing",
  tool: "Working",
  compacting: "Compacting context",
  retrying: "Retrying",
  starting_turn: "Starting",
};

/** What an agent is doing, in plain words, for the tree. Pure. */
export function agentActivity(agent: Agent): string {
  const status = agent.status;
  switch (status.state) {
    case "starting":
      return "Starting";
    case "working":
      return status.detail ?? activities[status.activity] ?? "Working";
    case "blocked":
      if (status.on === "human") return "Needs you";
      if (status.on === "subagents") return "Waiting for subagents";
      if (status.on === "background_task") return "Waiting on a background task";
      return status.message ?? `Waiting on ${status.on.replace("_", " ")}`;
    case "idle":
      return "Done";
    case "interrupted":
      return "Stopped";
    case "failed":
      return status.error.message;
    case "unresponsive":
      return "Not responding";
  }
}

// 22px per level; the elbow connector sits under the parent's status mark.
function indent(depth: number): CSSProperties {
  return { paddingLeft: 8 + depth * 22, ["--connector" as string]: `${depth * 22 - 7}px` };
}

/**
 * One agent in a tree: status mark, name, what it is doing, its provider and model, and Open
 * for a delegate that runs in a thread of its own. Re-renders only for its agent.
 */
export function AgentRow(props: { threadId: string; agentId: string; depth: number }) {
  const agent = useAgent(props.threadId, props.agentId);
  if (!agent) return null;
  return (
    <div
      role="treeitem"
      aria-level={props.depth + 1}
      aria-label={`${agentName(agent)}: ${agentActivity(agent)}`}
      aria-selected={false}
      style={indent(props.depth)}
      className={cn(
        "relative flex h-[30px] items-center gap-2 rounded-md pr-2 text-ui",
        props.depth > 0 &&
          "before:absolute before:top-[-6px] before:bottom-1/2 before:left-(--connector) before:w-2.5 before:rounded-bl-[6px] before:border-b-[1.5px] before:border-l-[1.5px]",
      )}
    >
      {agent.childThreadId ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: agent.childThreadId }}
          aria-label={`Open ${agentName(agent)}'s thread`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md focus-ring"
        >
          <AgentWords agent={agent} />
        </Link>
      ) : (
        <AgentWords agent={agent} />
      )}
    </div>
  );
}

function AgentWords({ agent }: { agent: Agent }) {
  return (
    <>
      <span className="grid w-3 shrink-0 place-items-center">
        <ProviderIcon provider={agent.native.provider} size={14} decorative />
      </span>
      <span className="shrink-0 font-medium whitespace-nowrap">{agentName(agent)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {agentActivity(agent)}
      </span>
      <span className="max-w-[18ch] shrink-0 truncate text-xs text-muted-foreground">
        {agent.model
          ? modelLine(agent.native.provider, agent.model)
          : providerNames[agent.native.provider]}
      </span>
    </>
  );
}

/** An agent and, below it, every descendant it has spawned. */
export function AgentBranch(props: { threadId: string; agentId: string; depth?: number }) {
  const depth = props.depth ?? 0;
  const read = useCallback(
    (reader: ThreadReader) => reader.children(props.agentId),
    [props.agentId],
  );
  const children = useThread(props.threadId, ["agents"], read, arrayEqual) ?? [];
  return (
    <>
      <AgentRow threadId={props.threadId} agentId={props.agentId} depth={depth} />
      {children.map((child) => (
        <AgentBranch key={child} threadId={props.threadId} agentId={child} depth={depth + 1} />
      ))}
    </>
  );
}
