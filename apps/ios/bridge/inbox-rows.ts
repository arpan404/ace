import {
  listOrderOf,
  threadMenu,
  threadMenuLabels,
  threadMenuSection,
  threadsTabs,
  type AccountView,
  type ThreadMenuId,
  type HomeSort,
} from "@ace/ui-core";
import {
  chatMenu,
  chatSections,
  inboxGroup,
  isChatThread,
  inboxGroupRank,
  inboxNeedsYou,
  inboxSections,
  inboxStatus,
  snoozePresets,
  type InboxSectionOptions,
  type InboxThread,
  type InboxUnsent,
} from "@ace/ui-core/mobile";
import { threadRow } from "./presentation.ts";
import { inboxLook } from "./inbox-look.ts";
import { rowAccount } from "./inbox-accounts.ts";
import { inboxSortChoices } from "./inbox-sort.ts";

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
  /** The machine's `threads.sortBy`, which orders the sections. */
  sortBy?: HomeSort;
}

/**
 * One thread's inbox row as Swift draws it: the ready-made status and look from the shared
 * rules, so an unconfirmed thread reads as the web reads it (Syncing, never Done).
 */
export function inboxRow(thread: InboxThread, context: RowContext) {
  const { entry } = thread;
  const look = inboxLook(thread, context.baseline, context.now);
  const menu = threadMenu(entry, {
    settled: look.settled,
    unread: look.unread,
    pinned: entry.pinned === true,
  });
  return {
    ...threadRow(entry),
    machineId: context.machineId,
    status: inboxStatus(thread, context.now),
    look,
    account: rowAccount(context.accounts, entry),
    activityAt: entry.activityAt ?? entry.updatedAt,
    archivedAt: entry.archivedAt ?? null,
    pinned: entry.pinned === true,
    /**
     * The group the thread's state puts it in (snoozed, settled, done…), even while it shows
     * under Pinned, so its row still offers Wake or Unsettle and says when it wakes.
     */
    group: inboxGroup(thread, context.now) ?? null,
    /** Places a move is worked out from (`inbox-place.ts`): among pinned, and sorted by hand. */
    pinOrder: entry.pinned === true ? (entry.pinOrder ?? null) : null,
    listOrder: listOrderOf(entry),
    /** False when the thread never settles by itself. */
    autoSettle: entry.autoSettle !== false,
    /**
     * What its menus offer, in order, by the web's rules (`threadMenu`); the words are the
     * layout's `menuLabels`.
     */
    menu,
    /** A chat's row menu in the Chats tab (`chatMenu`); null for a project thread. */
    chatMenu: isChatThread(thread) ? chatMenu(menu) : null,
  };
}

const menuSections = Object.fromEntries(
  (Object.keys(threadMenuLabels) as ThreadMenuId[]).map((id) => [id, threadMenuSection(id)]),
);

/**
 * The shared grouping as ordered sections, each row with its rank for merging machines and the
 * Threads tab that lists it (Inbox, Snoozed or Settled, ADR 0107), and the tabs themselves.
 */
export function inboxLayout(
  threads: readonly InboxThread[],
  unsent: readonly InboxUnsent[],
  now: number,
  more: boolean,
  options: InboxSectionOptions = {},
) {
  const sections = inboxSections(threads, unsent, now, options);
  const needsYou = inboxNeedsYou(threads, now);
  return {
    type: "inbox.sections",
    sections: sections.map((section) => ({
      key: section.key,
      label: section.label,
      tab: section.tab,
      ids: section.keys,
      // Rows on the phone may be fewer: the daemon pages older settled threads.
      total: section.total,
      // A merged inbox orders sections from every machine by these (`inboxRank`).
      ranks: section.ranks,
      order: inboxGroupRank(section.key),
    })),
    /**
     * Inbox, Snoozed and Settled in order, each with the threads it counts on this machine
     * (Settled counts what the daemon pages too; unsent sends are not threads) and, for the
     * Inbox, how many need the person: the tab's dot. The app adds machines up.
     */
    tabs: threadsTabs.map(({ id, label }) => ({
      id,
      label,
      count: sections
        .filter((section) => section.tab === id && section.key !== "unsent")
        .reduce((sum, section) => sum + section.total, 0),
      needsYou: id === "inbox" ? needsYou : 0,
    })),
    more,
    snooze: snoozePresets(now).map((preset) => ({ id: preset.id, label: preset.label })),
    // The machine's sort, so the menu checks the choice in force.
    sortBy: options.sortBy ?? "activity",
    sorts: inboxSortChoices,
    /** The words for each row's `menu` ids, and the block each belongs to. */
    menuLabels: threadMenuLabels,
    menuSections: menuSections,
  };
}

/** The Chats tab's sections (`chatSections`), in the inbox layout's shape so Swift merges them alike. */
export function chatsLayout(
  chats: readonly InboxThread[],
  now: number,
  baseline: number,
  query: string,
) {
  return {
    type: "chats.sections",
    sections: chatSections(chats, { now, baseline, query }).map((section) => ({
      key: section.key,
      label: section.label,
      ids: section.keys,
      ranks: section.ranks,
      order: section.order,
      settled: section.settled,
    })),
    more: false,
    snooze: [],
    query,
  };
}
