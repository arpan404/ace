import { livePlanStep, type TurnActivity } from "@ace/ui-core";
import { useShownPlans } from "@/lib/use-plans.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { PauseCircleIcon } from "@phosphor-icons/react";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { ThinkingRow } from "./step-groups-view.tsx";
import { SystemRow } from "./system-row.tsx";

/*
 * The live turn's header, right under the ask that started it: one muted `[grid] Working for 3m 6s`
 * row over a hairline, the turn's steps flowing below it. It reads the same `turnActivity` as
 * every other surface, counting the whole tree. The timer writes its text through a ref, so a
 * ticking second re-renders nothing, and it stands at the time reached while the turn waits on
 * the person (that time comes from the thread, so a redrawn header shows it too).
 */

export function LiveHead(props: { threadId: string }) {
  const activity = useTurnActivity(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const plans = useShownPlans(props.threadId);
  const live = useLiveConnection();
  const progress = plans[0] ? livePlanStep(plans[0].progress) : undefined;
  // A pause is the turn's own row; a lost connection is the header's to say.
  if (!activity || activity.tone === "paused" || live.staleLabel) return null;
  // The status line stays a live region of its own; the whole row also opens the Summary.
  return (
    <div
      role="group"
      aria-label="Turn in progress"
      className="relative border-b border-border pb-2"
    >
      <ActivityLine activity={activity} progress={progress} />
      <button
        type="button"
        aria-label="Open the summary"
        onClick={() => workspace.open({ kind: "work" })}
        className="absolute inset-0 rounded-sm focus-ring"
      />
    </div>
  );
}

/**
 * The live line, muted: `[grid] Working for 1m 14s` moving; `● Waiting for your answer`
 * while the person is asked (the request itself is in the composer's strip); a held line as it
 * is; a usage-limit pause as a quiet row.
 */
export function ActivityLine(props: { activity: TurnActivity; progress?: string | undefined }) {
  const { activity } = props;
  if (activity.tone === "paused")
    return (
      <SystemRow
        role="status"
        text={activity.label}
        icon={<PauseCircleIcon aria-hidden size={14} />}
      />
    );
  const label = activity.code ? `${activity.label} ${activity.code}` : activity.label;
  return (
    <p
      role="status"
      aria-label={label}
      className="@container/live flex min-h-8 min-w-0 items-center text-ui text-muted-foreground"
    >
      {activity.tone === "working" ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <WorkingIndicator
            label={activity.label}
            from={activity.elapsedFrom}
            className="shrink-0"
          />
          <Context activity={activity} progress={props.progress} />
        </span>
      ) : activity.tone === "needs-you" ? (
        // Waiting on the person outranks working: never "Working", no timer. The request
        // itself sits in the composer's strip.
        <span className="flex min-w-0 items-center gap-2">
          <Dot tone="needs-you" className="mx-0.5" />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </p>
  );
}

const orderKeys: readonly ThreadKey[] = ["order"];
/** Whether the newest item is a thought still being written (it says "Thinking" itself). */
function readThinking(reader: ThreadReader): Watched<boolean> {
  const last = reader.order.at(-1);
  const item = last === undefined ? undefined : reader.item(last);
  return {
    value: item?.type === "reasoning" && !item.complete,
    watch: last === undefined ? [] : [`item:${last}`],
  };
}

/** "Thinking", closing the working turn's flow, while no step is in flight. */
export function TailThinking(props: { threadId: string }) {
  const activity = useTurnActivity(props.threadId);
  const thought = useWatched(props.threadId, orderKeys, readThinking, Object.is) ?? false;
  if (activity?.tone !== "working" || activity.current || thought) return null;
  return (
    <ul aria-label="Working" className="flex flex-col">
      <ThinkingRow />
    </ul>
  );
}

/** What else the whole tree is doing, quietly after the time: the plan's step, subagents, commands. */
function Context(props: { activity: TurnActivity; progress: string | undefined }) {
  const { activity } = props;
  const commands = activity.backgroundCommands;
  const parts = [
    props.progress,
    activity.subagents
      ? `${activity.subagents} ${activity.subagents === 1 ? "subagent" : "subagents"}`
      : undefined,
  ].filter(Boolean);
  if (!parts.length && !commands) return null;
  return (
    <span className="min-w-0 truncate">
      {` · ${parts.join(" · ")}`}
      {commands ? (
        <>
          {parts.length ? " · " : ""}
          {commands} {/* A narrow column says "1 command": the line keeps its counts whole. */}
          <span className="@max-[30rem]/live:hidden">background </span>
          {commands === 1 ? "command" : "commands"}
        </>
      ) : null}
    </span>
  );
}
