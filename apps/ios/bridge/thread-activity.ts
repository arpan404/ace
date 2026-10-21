import type { ChangeTap, ThreadSource } from "@ace/client";
import {
  pluralCount,
  readTurnActivity,
  timedWords,
  waitWords,
  workingSubagentsText,
  type TurnActivity,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * The thread's live state, worded for a phone from the web's shared `turnActivity`: the inline
 * line at the top of the live turn ("Working for 1m 14s · 2 subagents working"), and, while the
 * main agent does nothing itself, the composer strip's words ("Waiting for 2 subagents · 1
 * command running") with what its Stop ends. Never derived in Swift, so the phone can't call a
 * tree done while any of it still works. Null when nothing is live. Re-read only when a key the
 * line was read from changes.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
type Reader = Pick<ThreadSource, "task">;

/** Membership keys that can move the line, besides the root agent and what it last read. */
const always = ["order", "agents", "tasks", "queue", "interactions", "thread"];

/** What else the tree does, after the time: subagents still working, background commands. */
function contextOf(activity: TurnActivity): string {
  const parts: string[] = [];
  const subagents = activity.waitingOnSubagents ? 0 : (activity.subagents ?? 0);
  if (subagents > 0) parts.push(workingSubagentsText(subagents));
  const commands = activity.backgroundCommands ?? 0;
  if (commands > 0) parts.push(pluralCount(commands, "command", "commands"));
  return parts.join(" · ");
}

/**
 * The strip's words while the main agent only waits, and what its Stop ends: the whole tree
 * (`tree`), or the background commands it waits on that ace can stop (`commands`).
 */
function waitOf(activity: TurnActivity, reader: Reader) {
  const wait = activity.waitingOn;
  if (!wait) return null;
  const words = waitWords(wait);
  const taskIds =
    wait.kind === "background"
      ? wait.taskIds.filter((id) => {
          const task = reader.task(id);
          return task?.status === "running" && task.stoppable;
        })
      : [];
  return {
    label: preview(words.label, 256),
    code: preview(words.code ?? "", 512),
    detail: preview(words.detail ?? "", 256),
    /** Subagents carry the turn's timer beside them; commands alone don't. */
    timed: wait.kind === "subagents",
    stop: wait.kind === "subagents" ? "tree" : "commands",
    taskIds,
  };
}

export function activityRow(activity: TurnActivity | undefined, reader: Reader) {
  if (!activity) return null;
  const label = activity.code
    ? `${activity.label} ${activity.code}`
    : activity.tone === "needs-you" && activity.asker
      ? `${activity.label} · ${activity.asker}`
      : activity.label;
  const timed = activity.tone === "working" && activity.elapsedFrom !== undefined;
  return {
    label: preview(label, 256),
    tone: activity.tone,
    /** The timer's origin in ms, already moved past time spent waiting on the person. */
    since: activity.elapsedFrom ?? null,
    /** The words before the timer: "Working for", "Stopping…". */
    lead: timed ? preview(timedWords(activity.label), 256) : "",
    /**
     * Whether the inline line shows: a pause is the turn's own row, what the main agent only
     * waits on is the strip's, and a question the root asked is its own line in the transcript.
     */
    inline: !(activity.tone === "paused" || activity.waitingOn || activity.askedInline),
    context: preview(activity.tone === "working" ? contextOf(activity) : "", 256),
    wait: waitOf(activity, reader),
  };
}

/** Follow the open thread's live line, putting `thread.activity` whenever it may have moved. */
export function followActivity(store: ThreadSource, put: Put): ChangeTap {
  let watch = new Set<string>();
  const emit = () =>
    put("activity", () => {
      const rootId = store.thread?.rootAgentId ?? "";
      const reading = readTurnActivity(store, rootId, { threadStatus: store.thread?.status });
      const row = activityRow(reading.activity, store);
      const tasks = row?.wait?.taskIds.map((id) => `task:${id}`) ?? [];
      watch = new Set([...always, `agent:${rootId}`, ...reading.watch, ...tasks]);
      return { type: "thread.activity", row };
    });
  return (keys) => {
    if (keys === "all") return emit();
    for (const key of keys) if (watch.has(key)) return emit();
  };
}
