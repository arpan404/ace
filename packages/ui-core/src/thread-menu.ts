import type { ThreadListEntry, ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import { listTreeFacts, treeInBackground, treeWorking } from "./live-status.ts";
import { pluralCount } from "./counts.ts";
import type { ThreadRowFlags } from "./thread-card.ts";

/**
 * Everything a person can do to one thread, in menu order, as ids every client draws: the web's
 * ⋯ menu, row menu and palette, and the phone's row menu, thread menu and selection bar. Each
 * client maps an id to its own icon and handler; the words and the rules for which apply are
 * here, so no two surfaces drift apart. Snooze and Continue on are the clients' own (a submenu
 * of times; a machine picker shown only while machines link).
 */
export type ThreadMenuId =
  | "new-on-main"
  | "rename"
  | "fork"
  | "copy-link"
  | "unread"
  | "read"
  | "pin"
  | "unpin"
  | "move"
  | "settle"
  | "unsettle"
  | "auto-settle-off"
  | "auto-settle-on"
  | "archive"
  | "restore"
  | "delete";

/** The block an action belongs to: menus separate blocks. */
export type ThreadMenuSection = "start" | "read" | "settle" | "leave";

export const threadMenuLabels: Readonly<Record<ThreadMenuId, string>> = {
  "new-on-main": "New thread from default branch",
  rename: "Rename",
  fork: "Fork from the last turn…",
  "copy-link": "Copy link",
  unread: "Mark unread",
  read: "Mark read",
  pin: "Pin",
  unpin: "Unpin",
  move: "Move to project…",
  settle: "Settle",
  unsettle: "Unsettle",
  "auto-settle-off": "Turn off auto-settle",
  "auto-settle-on": "Turn on auto-settle",
  archive: "Archive",
  restore: "Restore from archive",
  delete: "Delete thread",
};

const sections: Readonly<Record<ThreadMenuId, ThreadMenuSection>> = {
  "new-on-main": "start",
  rename: "start",
  fork: "start",
  "copy-link": "start",
  unread: "read",
  read: "read",
  pin: "read",
  unpin: "read",
  move: "read",
  settle: "settle",
  unsettle: "settle",
  "auto-settle-off": "settle",
  "auto-settle-on": "settle",
  archive: "leave",
  restore: "leave",
  delete: "leave",
};

export function threadMenuSection(id: ThreadMenuId): ThreadMenuSection {
  return sections[id];
}

/** Only Delete is drawn as destructive; it always asks first. */
export function threadMenuDanger(id: ThreadMenuId): boolean {
  return id === "delete";
}

/**
 * Settle any thread that is not working, or Unsettle a settled one; nothing while work
 * continues, since the daemon settles only non-working threads.
 */
export function settleChoice(
  entry: Pick<ThreadListEntry, "status">,
  flags: Pick<ThreadRowFlags, "settled">,
): "settle" | "unsettle" | undefined {
  if (flags.settled) return "unsettle";
  return entry.status.state === "working" ? undefined : "settle";
}

/** Turn the thread's own auto-settle off (it stays until settled by hand) or back on. */
export function autoSettleChoice(
  entry: Pick<ThreadListEntry, "autoSettle">,
): "auto-settle-off" | "auto-settle-on" {
  return entry.autoSettle === false ? "auto-settle-on" : "auto-settle-off";
}

/**
 * The thread's actions in menu order: start another, rename, fork, link; read, pin and move;
 * settle and auto-settle; archive (or, archived, restore) and permanent delete.
 */
export function threadMenu(
  entry: Pick<ThreadListEntry, "status" | "autoSettle" | "archivedAt">,
  flags: Pick<ThreadRowFlags, "settled" | "unread" | "pinned">,
): ThreadMenuId[] {
  const settle = settleChoice(entry, flags);
  return [
    "new-on-main",
    "rename",
    "fork",
    "copy-link",
    flags.unread ? "read" : "unread",
    flags.pinned ? "unpin" : "pin",
    "move",
    ...(settle ? [settle] : []),
    autoSettleChoice(entry),
    entry.archivedAt === undefined || entry.archivedAt === null ? "archive" : "restore",
    "delete",
  ];
}

/**
 * What still goes on in a listed thread's agent tree, in words for a question asked before
 * archiving it, or undefined when nothing does. Waiting on the person counts, and so do
 * background commands left after the turn: not Working, but archiving would hide them.
 */
export function runningWork(thread: {
  status: ThreadStatus;
  live?: ThreadRunMetadata | undefined;
}): string | undefined {
  const facts = listTreeFacts(thread);
  if (facts.needsYou) return "It's waiting for you.";
  if (!treeWorking(facts) && !treeInBackground(facts)) return undefined;
  const parts = [
    facts.root === "working" ? "the agent" : undefined,
    facts.subagents ? pluralCount(facts.subagents, "subagent", "subagents") : undefined,
    facts.backgroundCommands
      ? pluralCount(facts.backgroundCommands, "background command", "background commands")
      : undefined,
  ].filter((part) => part !== undefined);
  if (!parts.length) return "Its agent is still working.";
  const last = parts.pop();
  return `Still running: ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

/** The question asked before deleting a thread for good. */
export interface DeleteQuestion {
  /** "Delete thread?" or "Delete 3 threads?". */
  title: string;
  /** What happens: the thread is gone for good, then `running` when work still runs. */
  message: string;
  /** "2 agents running. Running work will stop before deletion.", or empty. */
  running: string;
  /** The confirming button: "Delete", or "Stop and delete" while work runs. */
  confirm: string;
  /** Whether the delete stops running work first (`thread.delete` `force`). */
  force: boolean;
}

/** Running agents, as the delete question counts them; none once the thread has stopped. */
function runningAgents(status: ThreadStatus): number {
  if (status.state === "done" || status.state === "failed") return 0;
  return status.state === "working" ? Math.max(1, status.agents) : 1;
}

/**
 * Ask before deleting `threads` for good. A thread with agents still running is deleted with
 * `force`, so its work stops before it goes; the question says so.
 */
export function deleteQuestion(
  threads: readonly { title: string; status: ThreadStatus }[],
): DeleteQuestion {
  const agents = threads.reduce((sum, thread) => sum + runningAgents(thread.status), 0);
  const only = threads.length === 1 ? threads[0] : undefined;
  const subject = only ? `“${only.title}”` : `${threads.length} threads`;
  const running = agents
    ? `${pluralCount(agents, "agent", "agents")} running. Running work will stop before deletion.`
    : "";
  return {
    title: only ? "Delete thread?" : `Delete ${threads.length} threads?`,
    message: `${subject} will be permanently deleted.${running ? ` ${running}` : ""}`,
    running,
    confirm: agents ? "Stop and delete" : "Delete",
    force: agents > 0,
  };
}
