import {
  elapsedShown,
  formatElapsed,
  subagentDetail,
  subagentLabels,
  subagentMeta,
  subagentTerminal,
  subagentToolId,
  type SubagentDetail,
} from "@ace/ui-core";
import { useAgent, useItem, useSidebarThread } from "@ace/client-react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { SubagentLink } from "@/lib/subagent-link.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import type { SubagentEntry } from "../lib/subagent-group.ts";
import { AgentRowContents, agentRowStyles, type AgentRowParts } from "./agent-row.tsx";

export { subagentTones } from "./agent-row.tsx";

/** Only this label subscribes to the shared, visibility-aware injected UI clock. */
export function SubagentElapsed(props: {
  startedAt: number;
  endedAt?: number | undefined;
  running: boolean;
  fresh: boolean;
}) {
  const now = useTicker(props.running && props.fresh);
  const end = props.running ? (props.fresh ? now : undefined) : props.endedAt;
  const elapsed = end === undefined ? undefined : end - props.startedAt;
  if (elapsed === undefined || !elapsedShown(elapsed)) return null;
  return <span aria-label="Elapsed time">{formatElapsed(elapsed)}</span>;
}

/** Its second line: what it does now, what it waits on, why it failed, or what it found. */
function useDetail(threadId: string, entry: SubagentEntry, fresh: boolean): SubagentDetail {
  const agent = useAgent(threadId, entry.agentId ?? "");
  const tool = useItem(threadId, subagentToolId(agent) ?? "");
  return subagentDetail(
    entry,
    agent,
    tool?.type === "tool_call" ? tool.call.title : undefined,
    fresh,
  );
}

/** "Opus 4.7 · High" for a subagent; "Delegated · GPT-5.5 · High" for a thread ace delegated. */
function useMeta(entry: SubagentEntry): string | undefined {
  const thread = useSidebarThread(entry.childThreadId ?? "");
  return subagentMeta(entry, thread?.execution);
}

/**
 * One subagent (or thread ace delegated) as a row: its provider's mark, its name and model, its
 * status word and how long it ran, and what it does now or found. The whole row opens it; one
 * that needs the person also offers Review, which opens it where its request waits.
 */
export function SubagentRow(props: {
  threadId: string;
  entry: SubagentEntry;
  fresh: boolean;
  /** It sits in a group's list, under the group's hairline, rather than flush in the transcript. */
  listed?: boolean | undefined;
}) {
  const { entry } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const { detail, kind } = useDetail(props.threadId, entry, props.fresh);
  const meta = useMeta(entry);
  const status = subagentLabels[entry.state];
  const label = entry.machine
    ? `${entry.title} on ${entry.machine}, ${status}`
    : entry.childThreadId
      ? `Open ${entry.title}'s thread, ${status}`
      : `Open ${entry.title}, ${status}`;
  const terminal = subagentTerminal(entry.state);
  const parts: AgentRowParts = {
    mark: { provider: entry.provider, model: entry.model },
    name: entry.title,
    meta,
    machine: entry.machine,
    state: entry.state,
    stale: !props.fresh && !terminal,
    elapsed: (
      <SubagentElapsed
        startedAt={entry.startedAt}
        endedAt={entry.endedAt}
        running={!terminal}
        fresh={props.fresh}
      />
    ),
    detail,
    detailKind: kind,
  };
  const classes = cn(agentRowStyles.box, props.listed && agentRowStyles.listed);
  const target =
    !entry.machine && (entry.agentId || entry.childThreadId)
      ? {
          threadId: props.threadId,
          agentId: entry.agentId ?? "",
          childThreadId: entry.childThreadId,
        }
      : undefined;
  return (
    <li data-subagent-state={entry.state} className="relative">
      {/* A child on another machine has no thread here: it opens the Summary instead. */}
      {target ? (
        <SubagentLink subagent={target} aria-label={label} className={classes}>
          <AgentRowContents {...parts} />
        </SubagentLink>
      ) : (
        // Its agent hasn't been seen yet: the spawn call is all there is, in the Work tree.
        <button
          type="button"
          aria-label={label}
          className={classes}
          onClick={() => workspace.open({ kind: "work" })}
        >
          <AgentRowContents {...parts} />
        </button>
      )}
      {kind === "human" && target && (
        <SubagentLink
          subagent={target}
          aria-label={`Review what ${entry.title} needs`}
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "absolute right-0 bottom-1 h-5 px-2 text-xs",
          )}
        >
          Review
        </SubagentLink>
      )}
    </li>
  );
}
