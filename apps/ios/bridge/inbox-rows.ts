import type { AccountView } from "@ace/ui-core";
import {
  inboxGroupRank,
  inboxSections,
  inboxStatus,
  snoozePresets,
  type InboxThread,
  type InboxUnsent,
} from "@ace/ui-core/mobile";
import { threadRow } from "./presentation.ts";
import { inboxLook } from "./inbox-look.ts";
import { rowAccount } from "./inbox-accounts.ts";

/** The phone's clock and timers, injected so a snooze's end is testable without waiting. */
export interface InboxClock {
  now(): number;
  set(delayMs: number, run: () => void): () => void;
}

/** What every inbox row is read against: its machine, the phone's clock and the accounts. */
export interface RowContext {
  machineId: string;
  now: number;
  /** When this phone started following the machine: results finished before it count as seen. */
  baseline: number;
  accounts: readonly AccountView[];
}

/**
 * One thread's inbox row as Swift draws it: the ready-made status and look from the shared
 * rules, so an unconfirmed thread reads as the web reads it (Syncing, never Done).
 */
export function inboxRow(thread: InboxThread, context: RowContext) {
  const { entry } = thread;
  return {
    ...threadRow(entry),
    machineId: context.machineId,
    status: inboxStatus(thread, context.now),
    look: inboxLook(thread, context.baseline, context.now),
    account: rowAccount(context.accounts, entry),
    activityAt: entry.activityAt ?? entry.updatedAt,
    archivedAt: entry.archivedAt ?? null,
  };
}

/** The shared grouping as ordered sections, each row with its rank for merging machines. */
export function inboxLayout(
  threads: readonly InboxThread[],
  unsent: readonly InboxUnsent[],
  now: number,
  more: boolean,
) {
  return {
    type: "inbox.sections",
    sections: inboxSections(threads, unsent, now).map((section) => ({
      key: section.key,
      label: section.label,
      ids: section.keys,
      // A merged inbox orders sections from every machine by these (`inboxRank`).
      ranks: section.ranks,
      order: inboxGroupRank(section.key),
    })),
    more,
    snooze: snoozePresets(now).map((preset) => ({ id: preset.id, label: preset.label })),
  };
}
