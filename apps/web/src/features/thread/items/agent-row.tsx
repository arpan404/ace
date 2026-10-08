import type { ThreadReader } from "@ace/client";
import { arrayEqual, useAgent, useThread } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useCallback, type CSSProperties } from "react";
import { Dot } from "@/components/ui/dot.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { agentName, providerNames } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";

const activities: Record<string, string> = {
  thinking: "Thinking",
  responding: "Writing",
  tool: "Using a tool",
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

function StatusMark(props: { agent: Agent }) {
  const state = props.agent.status.state;
  if (state === "blocked" && props.agent.status.on === "human")
    return <Dot tone="needs-you" label="Needs you" />;
  if (state === "failed") return <Dot tone="failed" label="Failed" />;
  if (state === "unresponsive") return <Dot tone="unresponsive" label="Not responding" />;
  if (state === "idle" || state === "interrupted")
    return <CheckIcon aria-label="Finished" size={12} className="text-subtle-foreground" />;
  return <LiveWorkMark label={state === "blocked" ? "Waiting" : "Working"} />;
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
      <span className="grid w-3 shrink-0 place-items-center">
        <StatusMark agent={agent} />
      </span>
      <span className="shrink-0 font-medium whitespace-nowrap">{agentName(agent)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {agentActivity(agent)}
      </span>
      <span className="max-w-[18ch] shrink-0 truncate rounded-sm bg-secondary px-1.5 py-px text-[11px] text-muted-foreground">
        {agent.model
          ? `${providerNames[agent.native.provider]} · ${agent.model}`
          : providerNames[agent.native.provider]}
      </span>
      {agent.childThreadId && (
        <Link
          to="/t/$threadId"
          params={{ threadId: agent.childThreadId }}
          aria-label={`Open ${agentName(agent)}'s thread`}
          className={buttonVariants({ variant: "ghost", size: "sm", className: "-mr-1.5" })}
        >
          Open
        </Link>
      )}
    </div>
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
