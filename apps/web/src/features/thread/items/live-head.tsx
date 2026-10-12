import { livePlanStep, type TurnActivity } from "@ace/ui-core";
import { useShownPlans } from "@/lib/use-plans.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { ThinkingRow } from "./step-groups-view.tsx";

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
  // A pause is the turn's own divider; a lost connection is the header's to say.
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
        aria-label="Open summary"
        onClick={() => workspace.open({ kind: "work" })}
        className="absolute inset-0 rounded-sm focus-ring"
      />
    </div>
  );
}

/**
 * The live line, muted: `[grid] Working for 1m 14s` moving; `Working for 1m 15s · Waiting for
 * your approval` standing still while the person is asked; a held line as it is; a usage-limit pause
 * as a divider.
 */
export function ActivityLine(props: { activity: TurnActivity; progress?: string | undefined }) {
  const { activity } = props;
  if (activity.tone === "paused")
    return (
      <Marker role="status" aria-label={activity.label} variant="separator" className="text-xs">
        <MarkerContent>{activity.label}</MarkerContent>
      </Marker>
    );
  const label = activity.code ? `${activity.label} ${activity.code}` : activity.label;
  return (
    <p
      role="status"
      aria-label={label}
      className="flex min-h-8 min-w-0 items-center text-ui text-muted-foreground"
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
        // The request itself sits in the composer's strip; here the time just stands still.
        <WorkingIndicator
          // Under a second reads as no time yet, not "0s".
          held={
            activity.elapsedMs !== undefined && activity.elapsedMs >= 1000
              ? activity.elapsedMs
              : undefined
          }
          moving={false}
          className="shrink-0"
        />
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
  const parts = [
    props.progress,
    activity.subagents
      ? `${activity.subagents} ${activity.subagents === 1 ? "subagent" : "subagents"}`
      : undefined,
    activity.backgroundCommands
      ? `${activity.backgroundCommands} ${
          activity.backgroundCommands === 1 ? "background command" : "background commands"
        }`
      : undefined,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="min-w-0 truncate">{` · ${parts.join(" · ")}`}</span>;
}
