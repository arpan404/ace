import {
  emptyInboxLine,
  eventSnoozes,
  snoozeLabel,
  emptyTabTitle,
  listOrderOf,
  threadsTabs,
  threadMenu,
  threadMenuLabels,
  threadMenuSection,
  type AccountView,
  type ThreadMenuId,
  type HomeSort,
} from "@ace/ui-core";
import type { ListAttention } from "@ace/protocol";
import {
  chatMenu,
  chatSections,
  inboxGroup,
  isChatThread,
  inboxGroupRank,
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
import { rowCard } from "./inbox-card.ts";
import { noAgentUse, type AgentUse } from "./inbox-agent-use.ts";
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
  /** What agents drive for each thread now (a browser, Mac apps). */
  use?: AgentUse;
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
    ...rowCard(entry, {
      baseline: context.baseline,
      now: context.now,
      settled: look.settled,
      accounts: context.accounts,
      use: context.use ?? noAgentUse,
    }),
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
    /**
     * The snoozes that end on an event and fit this thread now ("Until it needs you", "Until the
     * PR changes"), offered beside the layout's time presets; `id` is the action's preset.
     */
    snoozeEvents: eventSnoozes(entry).map((choice) => ({
      id: choice.wake,
      label: choice.label,
      detail: choice.detail,
    })),
    /** The event an event snooze waits for, kept so Undo of a settle can put it back. */
    snoozeOn: entry.snoozeWake?.on ?? null,
    /** Why an event snooze sleeps ("until it needs you"); null for a timed one or none. */
    snoozeWake: entry.snoozeWake ? (snoozeLabel(entry, context.now) ?? null) : null,
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

/** Which of the Threads panel's tabs each section belongs to. */
const sectionTabs: Record<string, "inbox" | "snoozed" | "settled" | undefined> = {
  pinned: "inbox",
  "needs-you": "inbox",
  working: "inbox",
  syncing: "inbox",
  threads: "inbox",
  done: "inbox",
  snoozed: "snoozed",
  settled: "settled",
};

/** The three tabs' threads in order, as the daemon placed them: what web and desktop list. */
function tabsOf(sections: readonly { key: string; keys: readonly string[] }[]) {
  const tabs = { inbox: [] as string[], snoozed: [] as string[], settled: [] as string[] };
  for (const section of sections) {
    const tab = sectionTabs[section.key];
    if (tab) tabs[tab].push(...section.keys);
  }
  return tabs;
}

/** The phone's tab after the Inbox, before Snoozed and Settled: the chats, where compose starts a chat. */
const chatsTab = {
  id: "chats",
  label: "Chats",
  counted: false,
  empty: "No chats yet",
  emptyLine: null,
  compose: "chat" as const,
};

/** The shared grouping as ordered sections, each row with its rank for merging machines. */
export function inboxLayout(
  threads: readonly InboxThread[],
  unsent: readonly InboxUnsent[],
  now: number,
  more: boolean,
  options: InboxSectionOptions & {
    /** The machine's rail dots for Threads and Chats, as its daemon sent them. */
    attention?: ListAttention | undefined;
  } = {},
) {
  const sections = inboxSections(threads, unsent, now, options);
  return {
    type: "inbox.sections",
    // The tabs, kept in the launch checkpoint too, so its first frame lists them as placed.
    tabs: tabsOf(sections),
    /**
     * Each tab's words, in order: its label, whether its count shows (Inbox and Snoozed, as
     * DESIGN.md has it), what it says while empty and what the compose button starts there.
     * The lists are `tabs`, as placed; Chats, second, lists the chats layout instead.
     */
    tabWords: threadsTabs.flatMap(({ id, label }) => {
      const words = {
        id,
        label,
        counted: id !== "settled",
        empty: emptyTabTitle(id, undefined, false),
        emptyLine: id === "inbox" ? emptyInboxLine : null,
        compose: "thread" as const,
      };
      // Chats sits second, right after the Inbox.
      return id === "inbox" ? [words, chatsTab] : [words];
    }),
    ...(options.attention ? { attention: options.attention } : {}),
    sections: sections.map((section) => ({
      key: section.key,
      label: section.label,
      // The tab that lists it, said outright: a section whose rows are all still unloaded (Settled,
      // paged by the daemon) has no row to read it from.
      tab: sectionTabs[section.key] ?? "inbox",
      ids: section.keys,
      // Rows on the phone may be fewer: the daemon pages older settled threads.
      total: section.total,
      // A merged inbox orders sections from every machine by these (`inboxRank`).
      ranks: section.ranks,
      order: inboxGroupRank(section.key),
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
