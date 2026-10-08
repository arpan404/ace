import type { ProviderKind, ThreadListEntry } from "@ace/protocol";
import { activityOf, isSnoozed, isUnread } from "./thread-state.ts";
import { providerDisplayName, providerLabel } from "./providers.ts";
import { describeWake } from "./snooze.ts";
import { projectBadge, type ProjectBadge } from "./project-badge.ts";
import {
  runningSubagents,
  taskPill,
  threadStatusLabel,
  threadStatusMark,
  type TaskPill,
  type ThreadMarkKind,
  type Tone,
} from "./status.ts";
import { formatAge } from "./time.ts";

/** Git and machine facts a card shows, from the daemon's `details` projection. */
export interface CardDetails {
  branch?: string | undefined;
  pr?: number | undefined;
  /** The thread runs in its own worktree rather than the project checkout. */
  worktree?: boolean | undefined;
  /** Set when the thread runs on another machine. */
  machine?: string | undefined;
  diff?: { added: number; removed: number } | undefined;
}

/**
 * A card's details from the entry. `home` is the machine most threads run on (see
 * `homeMachine`); a card names its machine only when it is a different one.
 */
export function cardDetails(entry: ThreadListEntry, home: string | undefined): CardDetails {
  const details = entry.details;
  if (!details) return {};
  const machine = details.machine;
  return {
    branch: details.branch ?? undefined,
    pr: details.linkedPr?.number,
    worktree: details.mode === "worktree",
    machine: machine && home !== undefined && machine.host !== home ? machine.name : undefined,
    diff: details.diff && { added: details.diff.additions, removed: details.diff.deletions },
  };
}

/** How a person has organised a row, which decides its menu items and hover actions. */
export interface ThreadRowFlags {
  settled: boolean;
  unread: boolean;
  pinned: boolean;
  snoozed: boolean;
}

/** How a person has organised a thread: what its menus offer (Mark read or unread, Unpin…). */
export function threadRowFlags(
  entry: ThreadListEntry,
  input: { baseline: number; now: number; settled: boolean },
): ThreadRowFlags {
  return {
    settled: input.settled,
    unread: isUnread(entry, input.baseline),
    pinned: entry.pinned === true,
    snoozed: isSnoozed(entry, input.now),
  };
}

/** Everything a Home card or settled row shows, already worded. */
export interface ThreadCard {
  id: string;
  title: string;
  project: string;
  /** Two letters on a tint that stays with the project. */
  badge: ProjectBadge;
  /** "now", "4m", "2d". */
  age: string;
  flags: ThreadRowFlags;
  /** Medium weight: it needs you or has activity the person hasn't opened. */
  emphasis: boolean;
  /** Quiet: done and read, nothing left to look at. Settled rows are quiet too. */
  dimmed: boolean;
  /** The status pill on the first line; without one the row shows its age. */
  pill: TaskPill | undefined;
  /** Lines added and removed in the thread's checkout. */
  diff: { added: number; removed: number } | undefined;
  /** Say "unread" to assistive tech; a thread that needs you already says so. */
  announceUnread: boolean;
  /** "tomorrow 9:00 AM" while snoozed. */
  wake: string | undefined;
  machine: string | undefined;
  /**
   * The branch, only when it says something: not the project's default branch. `label` is the
   * name cut in the middle to fit a row; `name` is whole, for the tooltip.
   */
  branch: { name: string; label: string; pr: number | undefined; worktree: boolean } | undefined;
  status: { label: string; tone: Tone; mark: ThreadMarkKind };
  provider: ProviderKind;
  /** The ACP registry agent behind an `acp` thread, which picks its mark and name. */
  acpAgentId: string | undefined;
  /** Subagents working beside the root agent right now. */
  subagents: number;
  /** "Codex · 2 subagents running". */
  providerLabel: string;
}

export interface ThreadCardInput {
  entry: ThreadListEntry;
  details?: CardDetails | undefined;
  /** Activity before this moment counts as seen. */
  baseline: number;
  /** Shown in the Settled section (see `arrange`). */
  settled: boolean;
  now: number;
  locale?: string;
  /** The project's name; its id when the name isn't known. */
  projectName?: string | undefined;
}

/**
 * The branch a project's own checkout sits on, which a row doesn't need to name. The thread
 * list doesn't carry each project's default branch, so the usual names stand in for it.
 */
export function isDefaultBranch(branch: string): boolean {
  return branch === "main" || branch === "master";
}

/** How many characters of a branch name a Home task row's last line shows beside its marks. */
export const branchLabelLength = 24;

/**
 * `text` cut to at most `max` characters by taking out its middle, so both the prefix and the
 * distinctive end stay: "work/re…treams".
 */
export function middleTruncateText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max < 3) return chars.slice(0, max).join("");
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}

/** The view model of one thread in the Home list. Pure: the caller passes the clock. */
export function threadCard(input: ThreadCardInput): ThreadCard {
  const { entry, details, now } = input;
  const flags = threadRowFlags(entry, input);
  const { snoozed, unread } = flags;
  const needsYou = entry.status.state === "needs_you";
  const subagents = runningSubagents(entry.status);
  const { label, tone } = threadStatusLabel(entry.status);
  return {
    id: entry.id,
    title: entry.title,
    project: input.projectName ?? entry.workspaceId,
    badge: projectBadge({ id: entry.workspaceId, name: input.projectName ?? entry.workspaceId }),
    age: formatAge(activityOf(entry), now),
    flags,
    emphasis: needsYou || unread,
    dimmed: input.settled || (entry.status.state === "done" && !unread),
    pill: input.settled ? undefined : taskPill(entry.status, { unread, since: activityOf(entry) }),
    diff:
      details?.diff && (details.diff.added > 0 || details.diff.removed > 0)
        ? details.diff
        : undefined,
    announceUnread: unread && !needsYou,
    wake:
      snoozed && entry.snoozedUntil !== undefined
        ? describeWake(entry.snoozedUntil, now, input.locale)
        : undefined,
    machine: details?.machine,
    branch:
      details?.branch && !isDefaultBranch(details.branch)
        ? {
            name: details.branch,
            label: middleTruncateText(details.branch, branchLabelLength),
            pr: details.pr,
            worktree: details.worktree === true,
          }
        : undefined,
    status: { label, tone, mark: threadStatusMark(entry.status) },
    provider: entry.provider,
    subagents,
    acpAgentId: entry.acpAgentId,
    providerLabel: providerLabel(providerDisplayName(entry.provider, entry.acpAgentId), subagents),
  };
}
