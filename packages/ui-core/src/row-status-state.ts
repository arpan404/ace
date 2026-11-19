import type { RowAttention } from "./row-attention.ts";
import type { RowStatusLook } from "./row-status-display.ts";

/**
 * Which state of the design language's status table a thread row is in, as one word a summary
 * can count. The attention level alone can't say it: `active` covers working, waits, usage
 * limits and background work, and only the first is work under way.
 * - `working`: the tree works, including a turn that ended while its subagents still work.
 * - `waiting`: any other wait (the queue, a recovery to review, the network or provider).
 * - `limited`: held at a usage limit, or resuming at its reset.
 * - `background`: only background commands run.
 * - `finished`: a result not yet seen.
 * - `syncing`: an unconfirmed copy that claims nothing.
 * - `idle`: at rest, or a failure already seen.
 */
export type RowStatusState =
  | "needs-you"
  | "failed"
  | "working"
  | "waiting"
  | "limited"
  | "background"
  | "finished"
  | "idle"
  | "syncing";

/** The row's state from its attention and the status mark it draws (`rowStatusLook`). Pure. */
export function rowStatusState(attention: RowAttention, look: RowStatusLook): RowStatusState {
  switch (attention.level) {
    case "needs-you":
      return "needs-you";
    case "failed":
      return "failed";
    case "done-unread":
      return "finished";
    case "syncing":
      return "syncing";
    case "failed-seen":
    case "quiet":
      return "idle";
    case "active":
      switch (look.icon) {
        case "working":
        case "agents":
          return "working";
        case "background":
          return "background";
        case "limited":
          return "limited";
        default:
          return "waiting";
      }
  }
}
