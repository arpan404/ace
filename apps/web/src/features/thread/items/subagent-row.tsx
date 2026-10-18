import type { ProviderKind } from "@ace/protocol";
import {
  describeActivity,
  formatElapsed,
  subagentLabels,
  subagentTerminal,
  type SubagentState,
} from "@ace/ui-core";
import { RobotIcon } from "@phosphor-icons/react";
import { useAgent, useItem } from "@ace/client-react";
import type { CSSProperties } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { SubagentLink } from "@/lib/subagent-link.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import type { SubagentEntry } from "../lib/subagent-group.ts";
import { RowParts, pressableRowClass } from "./transcript-row.tsx";

/** Each state's status tone (`data-tone`): its dot's hue and its words' AA hue. */
export const subagentTones: Record<SubagentState, string> = {
  working: "working",
  human: "needs-you",
  waiting: "waiting",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "idle",
  done: "done",
};

/** The status dot's cut-out: the avatar's corner is masked away, never ringed. */
const dotCut: CSSProperties = {
  maskImage:
    "radial-gradient(circle at calc(100% - 4px) calc(100% - 4px), transparent 5.5px, #000 6px)",
};

/**
 * A provider mark in a round avatar: 24px in a row, 20px in a stack. With a state, an 8px status
 * dot sits on its corner, cut out of the avatar rather than ringed.
 */
export function SubagentAvatar(props: {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  state?: SubagentState | undefined;
  size?: 20 | 24;
  style?: CSSProperties | undefined;
  className?: string | undefined;
}) {
  const small = props.size === 20;
  return (
    <span aria-hidden className={cn("relative flex shrink-0", props.className)}>
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-fill text-muted-foreground",
          small ? "size-5" : "size-6",
        )}
        style={props.state ? { ...props.style, ...dotCut } : props.style}
      >
        {props.provider ? (
          <ProviderIcon
            provider={props.provider}
            model={props.model}
            size={small ? 12 : 14}
            decorative
          />
        ) : (
          <RobotIcon size={small ? 12 : 14} />
        )}
      </span>
      {props.state && (
        <span
          data-tone={subagentTones[props.state]}
          className="absolute right-0 bottom-0 size-2 rounded-full bg-(--tone)"
        />
      )}
    </span>
  );
}

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
  if (elapsed === undefined || elapsed < 1000 || elapsed >= 7 * 24 * 3_600_000) return null;
  return <span aria-label="Elapsed time">{formatElapsed(elapsed)}</span>;
}

/** A live subagent's latest update, its row's second line. */
function SubagentActivity(props: { threadId: string; entry: SubagentEntry; fresh: boolean }) {
  const agent = useAgent(props.threadId, props.entry.agentId ?? "");
  const status = agent?.status;
  const itemId = status && status.state === "working" && status.itemId ? status.itemId : "";
  const tool = useItem(props.threadId, itemId);
  if (!agent || !status || !props.fresh) return null;
  if (status.state === "blocked" && status.on === "human") return null;
  if (
    status.state === "idle" ||
    status.state === "interrupted" ||
    status.state === "failed" ||
    status.state === "unresponsive"
  )
    return null;
  return describeActivity(status, tool?.type === "tool_call" ? tool.call.title : undefined);
}

/**
 * One subagent as a row: its avatar with a status dot, its name and status word, what it is
 * doing now (or, once settled, the first line of what it found), and how long it ran. The whole
 * row opens the subagent.
 */
export function SubagentRow(props: {
  threadId: string;
  entry: SubagentEntry;
  fresh: boolean;
  /** Its box, when it sits in the group's card rather than flush in the transcript. */
  className?: string | undefined;
}) {
  const { entry } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const status = subagentLabels[entry.state];
  const label = entry.machine
    ? `${entry.title} on ${entry.machine}, ${status}`
    : entry.childThreadId
      ? `Open ${entry.title}'s thread, ${status}`
      : `Open ${entry.title}, ${status}`;
  const terminal = subagentTerminal(entry.state);
  const stale = !props.fresh && !terminal;
  const parts = (
    <RowParts
      lead={<SubagentAvatar provider={entry.provider} model={entry.model} state={entry.state} />}
      tone="strong"
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">{entry.title}</span>
          {entry.machine && (
            <span className="shrink-0 truncate font-normal text-muted-foreground">
              on {entry.machine}
            </span>
          )}
          <span className="shrink-0 font-normal text-muted-foreground">
            {stale ? `Last seen: ${status}` : status}
          </span>
        </span>
      }
      subtitle={
        // A delegated thread reports no activity here: its result stays in view if it has one.
        terminal || !entry.agentId ? (
          entry.result
        ) : (
          <SubagentActivity threadId={props.threadId} entry={entry} fresh={props.fresh} />
        )
      }
      meta={
        <SubagentElapsed
          startedAt={entry.startedAt}
          endedAt={entry.endedAt}
          running={!terminal}
          fresh={props.fresh}
        />
      }
    />
  );
  const classes = props.className ?? pressableRowClass;
  return (
    <li data-subagent-state={entry.state}>
      {/* A child on another machine has no thread here: it opens the Summary instead. */}
      {!entry.machine && (entry.agentId || entry.childThreadId) ? (
        <SubagentLink
          subagent={{
            threadId: props.threadId,
            agentId: entry.agentId ?? "",
            childThreadId: entry.childThreadId,
          }}
          aria-label={label}
          className={classes}
        >
          {parts}
        </SubagentLink>
      ) : (
        // Its agent hasn't been seen yet: the spawn call is all there is, in the Work tree.
        <button
          type="button"
          aria-label={label}
          className={classes}
          onClick={() => workspace.open({ kind: "work" })}
        >
          {parts}
        </button>
      )}
    </li>
  );
}
