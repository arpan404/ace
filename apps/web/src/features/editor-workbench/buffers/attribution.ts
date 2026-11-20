/*
 * Who changed a file on disk (docs/editor/workbench.md 45): the thread whose live turn reported
 * an edit tool call on that path within 10 s before the change. This thread's call names its
 * agent; another thread's names that thread; with none the change is "Changed on disk".
 */

/** An edit tool call a live turn reported, as the client already receives it. */
export interface EditCall {
  threadId: string;
  threadTitle: string;
  /** The agent's display name, e.g. "Claude Code". */
  agent: string;
  /** The path the tool reported: checkout-relative or absolute. */
  path: string;
  /** When the call was reported, in ms. */
  at: number;
}

export type Author =
  /** This thread's agent. */
  | { kind: "agent"; agent: string; threadId: string }
  /** Another thread working in the same checkout. */
  | { kind: "thread"; threadId: string; title: string; agent: string }
  | { kind: "unknown" };

/** How long before a disk change an edit call still explains it. */
export const attributionWindow = 10_000;

export function attribute(
  change: {
    /** Checkout-relative path that changed. */
    path: string;
    at: number;
    /** The thread whose editor holds the file. */
    threadId: string;
    /** The checkout's absolute root, for calls that report absolute paths. */
    checkout: string;
  },
  calls: readonly EditCall[],
): Author {
  const path = normalize(change.path);
  const root = normalize(change.checkout);
  let best: EditCall | undefined;
  for (const candidate of calls) {
    const age = change.at - candidate.at;
    if (age < 0 || age > attributionWindow) continue;
    if (relative(normalize(candidate.path), root) !== path) continue;
    if (
      !best ||
      candidate.at > best.at ||
      (candidate.at === best.at && candidate.threadId === change.threadId)
    )
      best = candidate;
  }
  if (!best) return { kind: "unknown" };
  if (best.threadId === change.threadId)
    return { kind: "agent", agent: best.agent, threadId: best.threadId };
  return { kind: "thread", threadId: best.threadId, title: best.threadTitle, agent: best.agent };
}

function normalize(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return (absolute ? "/" : "") + parts.join("/");
}

/** A path inside `root` made relative to it; any other absolute path stays absolute. */
function relative(path: string, root: string): string {
  if (!path.startsWith("/")) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
