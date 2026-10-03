import type { ProviderKind, ThreadListEntry } from "@ace/protocol";
import { isSnoozed, isUnread } from "./arrange.ts";
import type { ThreadMark } from "./organizer.ts";
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

/** Git and machine facts for a thread card that the thread list entry doesn't carry yet. */
export interface ThreadDetails {
  branch: string;
  pr?: number;
  /** The thread runs in its own worktree rather than the project checkout. */
  worktree?: boolean;
  /** Set when the thread runs on another machine. */
  machine?: string;
  diff?: { added: number; removed: number };
}

/** How a person has organised a row, which decides its menu items and hover actions. */
export interface ThreadRowFlags {
  settled: boolean;
  unread: boolean;
  pinned: boolean;
  snoozed: boolean;
}

/** Everything a Home card or settled row shows, already worded. */
export interface ThreadCard {
  id: string;
  /** The local rename wins over the daemon's title until the rename reaches it. */
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
  mark: ThreadMark | undefined;
  details?: ThreadDetails | undefined;
  /** Activity before this moment counts as seen. */
  baseline: number;
  /** Shown in the Settled section (see `arrange`). */
  settled: boolean;
  now: number;
  locale?: string;
}

/** The view model of one thread in the Home list. Pure: the caller passes the clock. */
export function threadCard(input: ThreadCardInput): ThreadCard {
  const { entry, mark, details, now } = input;
  const snoozed = isSnoozed(mark, now);
  const unread = isUnread(entry, mark, input.baseline);
  const needsYou = entry.status.state === "needs_you";
  const subagents = runningSubagents(entry.status);
  const { label, tone } = threadStatusLabel(entry.status);
  return {
    id: entry.id,
    title: mark?.title ?? entry.title,
    project: entry.workspaceId,
    age: formatAge(entry.updatedAt, now),
    flags: {
      settled: input.settled,
      unread,
      pinned: mark?.pinned === true,
      snoozed,
    },
    emphasis: needsYou || unread,
    announceUnread: unread && !needsYou,
    wake:
      snoozed && mark?.snoozedUntil !== undefined
        ? describeWake(mark.snoozedUntil, now, input.locale)
        : undefined,
    machine: details?.machine,
    branch: details
      ? { name: details.branch, pr: details.pr, worktree: details.worktree === true }
      : undefined,
    status: { label, tone, mark: threadStatusMark(entry.status) },
    provider: entry.provider,
    subagents,
    providerLabel: providerLabel(entry.provider, subagents),
  };
}
