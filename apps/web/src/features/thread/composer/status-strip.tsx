import type { ThreadStatus } from "@ace/protocol";
import { formatElapsed } from "@ace/ui-core";
import { StopIcon } from "@phosphor-icons/react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useTicker } from "../lib/clock.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { AttachedCard } from "./attached-card.tsx";
import { useComposerCompact } from "./composer-compact.ts";
import { stripControl, stripRow } from "./composer-styles.ts";

/**
 * What the agents are doing, in the composer's tab while they work: "2 agents working · 1m 12s
 * · Running bun install", and Stop. The step in flight drops on a narrow composer. It reads the
 * turn's one live line, so it never disagrees with the transcript's.
 */
export function StatusStrip(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  stopping: boolean;
  onStop(): void;
}) {
  const compact = useComposerCompact();
  const activity = useTurnActivity(props.threadId);
  const now = useTicker(activity?.elapsedFrom !== undefined);
  const agents = props.status?.state === "working" ? props.status.agents : 1;
  // While Stop is on its way the button says so; the label keeps saying what is running.
  const label =
    agents > 1
      ? `${agents} agents working`
      : props.stopping
        ? "Working"
        : (activity?.label ?? "Working");
  const elapsed =
    activity?.elapsedFrom === undefined
      ? undefined
      : formatElapsed(Math.max(0, now - activity.elapsedFrom));
  return (
    <AttachedCard label="Agents" strip cardKey="status">
      <div className={cn(stripRow, "gap-2 pl-3.5")}>
        <Spinner />
        <p role="status" className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-foreground">{label}</span>
          {elapsed && <span className="shrink-0 tabular-nums">· {elapsed}</span>}
          {!compact && activity?.current && (
            <span className="min-w-0 truncate text-subtle-foreground">· {activity.current}</span>
          )}
        </p>
        {props.stopping ? (
          <Tip label="Stopping… the agent stops at its next safe point" side="top">
            <button
              type="button"
              aria-label="Stopping…"
              aria-disabled
              className={cn(stripControl, "shrink-0 cursor-default hover:bg-transparent")}
            >
              Stopping…
            </button>
          </Tip>
        ) : (
          <Tip label="Stop the agent and its subagents" side="top">
            <button
              type="button"
              aria-label="Stop the agent"
              onClick={props.onStop}
              className={cn(stripControl, "shrink-0 font-medium text-foreground")}
            >
              <StopIcon aria-hidden size={12} weight="fill" />
              Stop
            </button>
          </Tip>
        )}
      </div>
    </AttachedCard>
  );
}
