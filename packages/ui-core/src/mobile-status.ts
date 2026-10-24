import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { syncingWord } from "./row-attention.ts";
import { queuedPill, taskPill, type Tone } from "./status.ts";

/**
 * The design-token colour a native client paints a status with: a key of the shared `status`
 * and `statusText` palettes, or `neutral` for the muted ink of a state that claims nothing.
 */
export type StatusToken =
  | "needsYou"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "unresponsive"
  | "neutral";

/** A status as the native apps show it: the word and the token that colours it. */
export interface StatusDisplay {
  label: string;
  token: StatusToken;
}

const tokens: Record<ThreadStatus["state"], StatusToken> = {
  needs_you: "needsYou",
  working: "working",
  waiting: "waiting",
  limited: "waiting",
  done: "done",
  failed: "failed",
  unresponsive: "unresponsive",
  new: "neutral",
};

/**
 * The word and colour for the daemon's whole-tree status. Labelling only: the daemon decides
 * when a tree is done. Native rows always carry a word, so a done or new thread is named too.
 */
export function mobileStatus(status: ThreadStatus): StatusDisplay {
  const label = taskPill(status, { unread: true, since: 0 })?.label ?? "New";
  return { label, token: tokens[status.state] };
}

/** A thread's word and colour: Queued while, delegated past its parent's slots, it waits to start. */
export function mobileThreadStatus(
  thread: Pick<ThreadListEntry, "status" | "queuedLaunch">,
): StatusDisplay {
  return thread.queuedLaunch && thread.status.state === "new"
    ? { label: queuedPill.label, token: toneToken(queuedPill.tone) }
    : mobileStatus(thread.status);
}

/** A row restored from disk that the daemon hasn't confirmed: it claims no state. */
export const syncingStatus: StatusDisplay = { label: syncingWord, token: "neutral" };

const toneTokens: Record<Tone, StatusToken> = {
  "needs-you": "needsYou",
  working: "working",
  waiting: "waiting",
  failed: "failed",
  done: "done",
  idle: "neutral",
  background: "neutral",
};
/** The token for a shared tone, for words other modules already chose. */
export const toneToken = (tone: Tone): StatusToken => toneTokens[tone];
