import type { TurnActivity } from "@ace/ui-core";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { useWatched, type Watched } from "@/lib/use-watched.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { ThinkingRow } from "./step-groups-view.tsx";

/*
 * The live turn's header, right under the ask that started it: one muted `[grid] Working 3m 6s`
 * row over a hairline, the turn's steps flowing below it. It reads the same `turnActivity` as
 * every other surface, counting the whole tree. The timer writes its text through a ref, so a
 * ticking second re-renders nothing, and it stands at the time reached while the turn waits on
 * the person (that time comes from the thread, so a redrawn header shows it too).
 */

export function LiveHead(props: { threadId: string }) {
  const activity = useTurnActivity(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  if (!activity || activity.tone === "paused") return null;
  return (
    <button
      type="button"
      aria-label="Open work and agents"
      onClick={() => workspace.open({ kind: "work" })}
      className="block w-full border-b border-border pb-2 text-left focus-ring"
    >
      <ActivityLine activity={activity} />
    </button>
  );
}

/**
 * The live line, muted: `[grid] Working 1m 14s` moving; `Working 1m 15s · Waiting for your
 * approval` standing still while the person is asked; a held line as it is; a usage-limit pause
 * as a divider.
 */
export function ActivityLine(props: { activity: TurnActivity }) {
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
        <WorkingIndicator label={activity.label} from={activity.elapsedFrom} />
      ) : activity.tone === "needs-you" && activity.elapsedMs !== undefined ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <WorkingIndicator held={activity.elapsedMs} className="shrink-0" />
          <span className="min-w-0 truncate">{` · ${activity.label}`}</span>
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
