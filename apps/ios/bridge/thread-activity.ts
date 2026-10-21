import type { ChangeTap, ThreadSource } from "@ace/client";
import { pluralCount, readTurnActivity, type TurnActivity } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * The thread's one live line for the floating capsule above the composer: the web's shared
 * `turnActivity` (what the root is doing, what it waits on, its timer), worded for a phone. It
 * is never derived in Swift, so the capsule can't call a tree done while any of it still works.
 * Null when nothing is live. Re-read only when a key the line was read from changes.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

/** Membership keys that can move the line, besides the root agent and what it last read. */
const always = ["order", "agents", "tasks", "queue", "interactions", "thread"];

export function activityRow(activity: TurnActivity | undefined) {
  if (!activity) return null;
  const wait = activity.waitingOn;
  const background = wait?.kind === "background";
  const label = activity.waitingOnSubagents
    ? `Waiting on ${activity.subagents ?? 0}`
    : activity.code
      ? `${activity.label} ${activity.code}`
      : activity.label;
  const commands = background ? 0 : (activity.backgroundCommands ?? 0);
  return {
    label: preview(label, 256),
    tone: activity.tone,
    /** The timer's origin in ms, already moved past time spent waiting on the person. */
    since: activity.elapsedFrom ?? null,
    /** The root does nothing itself while its subagents work. */
    waiting: activity.waitingOnSubagents === true,
    commands: commands > 0 ? pluralCount(commands, "command", "commands") : "",
  };
}

/** Follow the open thread's live line, putting `thread.activity` whenever it may have moved. */
export function followActivity(store: ThreadSource, put: Put): ChangeTap {
  let watch = new Set<string>();
  const emit = () =>
    put("activity", () => {
      const rootId = store.thread?.rootAgentId ?? "";
      const reading = readTurnActivity(store, rootId, { threadStatus: store.thread?.status });
      watch = new Set([...always, `agent:${rootId}`, ...reading.watch]);
      return { type: "thread.activity", row: activityRow(reading.activity) };
    });
  return (keys) => {
    if (keys === "all") return emit();
    for (const key of keys) if (watch.has(key)) return emit();
  };
}
