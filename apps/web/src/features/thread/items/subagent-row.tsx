import type { ProviderKind } from "@ace/protocol";
import { formatElapsed, subagentLabels, subagentTerminal, type SubagentState } from "@ace/ui-core";
import { CaretRightIcon, RobotIcon } from "@phosphor-icons/react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { SubagentLink } from "@/lib/subagent-link.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useTicker } from "../lib/clock.ts";
import type { SubagentEntry } from "../lib/subagent-group.ts";

export const subagentTones: Record<SubagentState, string> = {
  working: "text-status-working",
  human: "text-status-needs-you",
  waiting: "text-status-waiting",
  unresponsive: "text-status-failed",
  failed: "text-status-failed",
  cancelled: "text-subtle-foreground",
  done: "text-status-done",
};

/** Static provider mark, with the status as a dot when one is given. */
export function SubagentAvatar(props: {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  state?: SubagentState | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full border bg-background",
        props.className,
      )}
    >
      {props.provider ? (
        <ProviderIcon provider={props.provider} model={props.model} size={18} decorative />
      ) : (
        <RobotIcon size={18} />
      )}
      {props.state && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-current ring-2 ring-background",
            subagentTones[props.state],
          )}
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
  return (
    <span
      aria-label="Elapsed time"
      className="shrink-0 text-xs text-subtle-foreground tabular-nums"
    >
      {formatElapsed(elapsed)}
    </span>
  );
}

/** States the person should act on or know went wrong: shown in words, not just a dot. */
const needsAttention = (state: SubagentState) =>
  state === "human" || state === "failed" || state === "unresponsive";

export function SubagentRow(props: { threadId: string; entry: SubagentEntry; fresh: boolean }) {
  const { entry } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const status = subagentLabels[entry.state];
  const label = entry.machine
    ? `${entry.title} on ${entry.machine}, ${status}`
    : entry.childThreadId
      ? `Open ${entry.title}'s thread, ${status}`
      : `Open ${entry.title}, ${status}`;
  // Status shows once: the avatar's dot, or, when it needs attention, words in its tone instead.
  const attention = needsAttention(entry.state);
  const stale = !props.fresh && !subagentTerminal(entry.state);
  const words = (
    <>
      <SubagentAvatar
        provider={entry.provider}
        model={entry.model}
        state={attention ? undefined : entry.state}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-ui font-medium">{entry.title}</span>
        {entry.machine && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            on {entry.machine}
          </span>
        )}
        {(attention || stale) && (
          <span className={cn("shrink-0 text-xs", subagentTones[entry.state])}>
            {stale ? `Last seen: ${status}` : status}
          </span>
        )}
      </span>
      <SubagentElapsed
        startedAt={entry.startedAt}
        endedAt={entry.endedAt}
        running={!subagentTerminal(entry.state)}
        fresh={props.fresh}
      />
      <CaretRightIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
    </>
  );
  const classes =
    "flex min-h-(--row-height) pointer-coarse:min-h-11 w-full items-center gap-(--surface-gap) rounded-md px-(--surface-inset) py-[calc(var(--setting-row-padding)/2)] text-left transition-colors duration-(--motion-fast) hover:bg-accent focus-ring-inset";
  return (
    <li>
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
          {words}
        </SubagentLink>
      ) : (
        // Its agent hasn't been seen yet: the spawn call is all there is, in the Work tree.
        <button
          type="button"
          aria-label={label}
          className={classes}
          onClick={() => workspace.open({ kind: "work" })}
        >
          {words}
        </button>
      )}
    </li>
  );
}
