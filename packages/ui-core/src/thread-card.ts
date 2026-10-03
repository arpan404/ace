import type { ProviderKind, ThreadListEntry } from "@ace/protocol";
import { activityOf, isSnoozed, isUnread } from "./arrange.ts";
import { providerLabel } from "./providers.ts";
import { describeWake } from "./snooze.ts";
import {
  runningSubagents,
  threadStatusLabel,
  threadStatusMark,
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
  /** "now", "4m", "2d". */
  age: string;
  flags: ThreadRowFlags;
  /** Medium weight: it needs you or has activity the person hasn't opened. */
  emphasis: boolean;
  /** Say "unread" to assistive tech; a thread that needs you already says so. */
  announceUnread: boolean;
  /** "tomorrow 9:00 AM" while snoozed. */
  wake: string | undefined;
  machine: string | undefined;
  branch: { name: string; pr: number | undefined; worktree: boolean } | undefined;
  status: { label: string; tone: Tone; mark: ThreadMarkKind };
  provider: ProviderKind;
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
    age: formatAge(activityOf(entry), now),
    flags,
    emphasis: needsYou || unread,
    announceUnread: unread && !needsYou,
    wake:
      snoozed && entry.snoozedUntil !== undefined
        ? describeWake(entry.snoozedUntil, now, input.locale)
        : undefined,
    machine: details?.machine,
    branch: details?.branch
      ? { name: details.branch, pr: details.pr, worktree: details.worktree === true }
      : undefined,
    status: { label, tone, mark: threadStatusMark(entry.status) },
    provider: entry.provider,
    subagents,
    providerLabel: providerLabel(entry.provider, subagents),
  };
}
