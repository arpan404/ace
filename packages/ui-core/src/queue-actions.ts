import { continueMessage } from "@ace/core";
import type { CommandPayload, QueueState, ThreadId } from "@ace/protocol";
import type { QueueAction } from "./queue.ts";

/*
 * What each queue-wide choice sends to the daemon (resume, pause, a limit choice, Continue), and
 * the queue's own Pause / Resume control. Every client builds the same command from the same
 * fresh queue state. Pure.
 */

export type QueueFence = Pick<QueueState, "revision" | "paused" | "reason">;

/**
 * The command for `action`, fenced to the queue's revision; undefined for a choice the client
 * handles itself (Pick another model opens the picker).
 */
export function queueActionPayload(
  action: QueueAction,
  threadId: ThreadId,
  queue: QueueFence,
): CommandPayload | undefined {
  const fresh = { threadId, expectedRevision: queue.revision };
  const restart = queue.paused && queue.reason === "restart";
  switch (action.id) {
    case "choose_model":
      return undefined;
    // Continue carries the turn on in the person's words: a restart resumes its native session
    // (the daemon sends them), anything else is simply their next message.
    case "continue":
      return restart
        ? { type: "thread.resume", ...fresh }
        : {
            type: "thread.send",
            threadId,
            input: [{ type: "text", text: continueMessage }],
            delivery: "queue",
          };
    case "resume":
      return { type: queue.reason === "restart" ? "thread.resume" : "queue.resume", ...fresh };
    case "hold":
      return { type: "queue.pause", ...fresh };
    case "migrate_now":
      return {
        type: "thread.limit",
        ...fresh,
        action: "migrate_now",
        ...(action.instanceId ? { instanceId: action.instanceId } : {}),
      };
    default:
      return { type: "thread.limit", ...fresh, action: action.id };
  }
}

/**
 * The queue's own Pause or Resume, shown beside the waiting messages: Pause while messages wait
 * and nothing holds them, Resume while the person's own pause holds them. Other holds (a limit,
 * a stop, a failed send) say their own way out, so this offers nothing then.
 */
export function queuePauseControl(
  queue: Pick<QueueState, "paused" | "reason"> | undefined,
  waiting: number,
): QueueAction | undefined {
  if (!queue || waiting === 0) return undefined;
  if (!queue.paused) return { id: "hold", label: "Pause queue" };
  return queue.reason === "manual" ? { id: "resume", label: "Resume queue" } : undefined;
}
