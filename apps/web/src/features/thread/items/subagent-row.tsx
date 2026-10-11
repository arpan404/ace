import type { ProviderKind } from "@ace/protocol";
import { formatElapsed, subagentLabels, subagentTerminal, type SubagentState } from "@ace/ui-core";
import { CaretRightIcon, RobotIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
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

/** Static provider mark; text alongside it always names the status. */
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
  return (
    <span
      aria-label="Elapsed time"
      className="shrink-0 text-xs text-subtle-foreground tabular-nums"
    >
      {elapsed !== undefined && elapsed >= 0 && elapsed < 7 * 24 * 3_600_000
        ? formatElapsed(elapsed)
        : "—"}
    </span>
  );
}

export function SubagentRow(props: { threadId: string; entry: SubagentEntry; fresh: boolean }) {
  const { entry } = props;
  const workspace = useWorkspaceActions(props.threadId);
  const status = subagentLabels[entry.state];
  const label = entry.childThreadId
    ? `Open ${entry.title}'s thread, ${status}`
    : `Open ${entry.title}, ${status}`;
  const words = (
    <>
      <SubagentAvatar provider={entry.provider} model={entry.model} state={entry.state} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium">{entry.title}</span>
        <span
          className={cn(
            "block text-xs",
            entry.state === "human" ? subagentTones.human : "text-muted-foreground",
          )}
        >
          {props.fresh || subagentTerminal(entry.state) ? status : `Last seen: ${status}`}
        </span>
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
    "flex min-h-(--row-height) pointer-coarse:min-h-11 w-full items-center gap-(--surface-gap) px-(--surface-inset) py-[calc(var(--setting-row-padding)/2)] text-left transition-colors duration-(--dur-1) hover:bg-accent focus-ring-inset";
  return (
    <li>
      {entry.childThreadId ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: entry.childThreadId }}
          aria-label={label}
          className={classes}
        >
          {words}
        </Link>
      ) : (
        <button
          type="button"
          aria-label={label}
          className={classes}
          onClick={() =>
            workspace.open(
              entry.agentId
                ? { kind: "agent", id: entry.agentId, title: entry.title }
                : { kind: "agents" },
            )
          }
        >
          {words}
        </button>
      )}
    </li>
  );
}
