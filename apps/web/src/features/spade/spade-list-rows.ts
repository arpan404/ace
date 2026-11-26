import {
  spadeBotRow,
  spadeGroupRow,
  spadeByState,
  spadeBotFamilies,
  type SpadeRow,
} from "@ace/ui-core/spade-chat";
import type { RosterBot } from "./use-spade-roster.ts";
import type { RosterGroup } from "./use-spade-groups.ts";

/*
 * The list's entries, nesting and search (docs/design/spade.md §2), over the row rules every
 * client shares (`@ace/ui-core/spade-chat`'s `spadeBotRow`). Pure, so the rules are tested directly.
 */

export {
  spadeBotRow,
  spadeGroupRow,
  type SpadeRow,
  type SpadeRowState,
} from "@ace/ui-core/spade-chat";

export type SpadeListEntry =
  | {
      kind: "bot";
      bot: RosterBot;
      row: SpadeRow;
      /** 1 for a worker shown under its maker, else 0. */
      depth: 0 | 1;
    }
  | { kind: "group"; group: RosterGroup; row: SpadeRow; depth: 0 };

const activity = (entry: SpadeListEntry) =>
  entry.kind === "bot" ? entry.bot.lastActivity : entry.group.lastActivity;

/** What the check found missing for bots it sent back, by `machine/id` (`useGoalMissing`). */
export type SpadeGoalMissing = ReadonlyMap<string, string>;

const botEntry = (
  bot: RosterBot,
  missing: SpadeGoalMissing | undefined,
  depth: 0 | 1 = 0,
): SpadeListEntry => ({
  kind: "bot",
  bot,
  row: spadeBotRow(bot, missing?.get(botKey(bot))),
  depth,
});

const byState = (entries: readonly SpadeListEntry[]) =>
  spadeByState(entries, (entry) => entry.row.state, activity);

/** A bot's key across machines: ids repeat between machines' Spades. */
const botKey = (bot: RosterBot) => `${bot.machine.key}/${bot.id}`;

/** One row per bot on a machine: the first of a repeated id stands, so no bot opens from two rows. */
function uniqueBots(bots: readonly RosterBot[]): RosterBot[] {
  const seen = new Set<string>();
  return bots.filter((bot) => {
    const key = botKey(bot);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Spade, the main bot, first as an ordinary row, then the rest by state, newest first. */
function topLevel(
  allBots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  missing: SpadeGoalMissing | undefined,
): SpadeListEntry[] {
  const bots = uniqueBots(allBots);
  const others: SpadeListEntry[] = [
    ...bots.filter((bot) => bot.kind !== "main").map((bot) => botEntry(bot, missing)),
    ...groups.map((group) => ({
      kind: "group" as const,
      group,
      row: spadeGroupRow(group),
      depth: 0 as const,
    })),
  ];
  const main = bots.filter((bot) => bot.kind === "main").map((bot) => botEntry(bot, missing));
  return [...main, ...byState(others)];
}

/**
 * Every row in the list's order, what the search looks through: the bots the person talks to.
 * A bot another bot made is that bot's own worker and has no row.
 */
export function spadeFlatEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  missing?: SpadeGoalMissing,
): SpadeListEntry[] {
  const families = spadeBotFamilies(bots, (bot, id) => `${bot.machine.key}/${id}`);
  return topLevel(
    families.map(({ root }) => root),
    groups,
    missing,
  );
}

/** The list's rows: the same bots the search looks through, in the list's order. */
export function spadeListEntries(
  allBots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  missing?: SpadeGoalMissing,
): SpadeListEntry[] {
  return spadeFlatEntries(allBots, groups, missing);
}

/**
 * When the person pinned the conversation (ms); undefined when it isn't pinned. Spade, the main
 * bot, is never pinned: it is the list's first row wherever it was pinned before.
 */
export const pinnedAt = (entry: SpadeListEntry): number | undefined =>
  entry.kind === "group"
    ? entry.group.pinnedAt
    : entry.bot.kind === "main"
      ? undefined
      : entry.bot.pinnedAt;

/**
 * The list in its order: Spade, the main bot, first, then the pinned conversations, oldest pin
 * first, then the rest as `entries` has them. Pins draw on `all`, so a pinned worker shows while
 * its family is folded; a worker whose maker was pinned has no row to nest under and stands alone.
 */
export function spadePinnedFirst(
  entries: readonly SpadeListEntry[],
  all: readonly SpadeListEntry[] = entries,
): SpadeListEntry[] {
  const pinned = all
    .filter((entry) => pinnedAt(entry) !== undefined)
    .toSorted((a, b) => (pinnedAt(a) ?? 0) - (pinnedAt(b) ?? 0));
  const pinnedBots = new Set(
    pinned.flatMap((entry) => (entry.kind === "bot" ? [botKey(entry.bot)] : [])),
  );
  const rest = entries
    .filter((entry) => pinnedAt(entry) === undefined)
    .map((entry): SpadeListEntry => {
      if (
        entry.kind === "bot" &&
        entry.depth === 1 &&
        entry.bot.parent &&
        pinnedBots.has(`${entry.bot.machine.key}/${entry.bot.parent.id}`)
      )
        return Object.assign({}, entry, { depth: 0 });
      return entry;
    });
  const isMain = (entry: SpadeListEntry) => entry.kind === "bot" && entry.bot.kind === "main";
  return [...rest.filter(isMain), ...pinned, ...rest.filter((entry) => !isMain(entry))];
}

function words(entry: SpadeListEntry): string[] {
  const said = entry.kind === "bot" ? entry.bot.lastMessage?.text : entry.group.lastMessage?.text;
  const named =
    entry.kind === "bot"
      ? [entry.bot.name]
      : [entry.group.name, ...entry.group.members.map((member) => member.name)];
  return [...named, entry.row.line, said ?? ""];
}

/** The rows whose name, line, last message or (a group's) members hold the search's words. */
export function searchSpadeList(
  entries: readonly SpadeListEntry[],
  query: string,
): SpadeListEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    words(entry).some((text) => text.toLocaleLowerCase().includes(needle)),
  );
}

/** A row's key in the list: its machine and its bot's or group's id. */
export const spadeEntryKey = (entry: SpadeListEntry) =>
  entry.kind === "bot"
    ? `${entry.bot.machine.key}/${entry.bot.id}`
    : `group:${entry.group.machine.key}/${entry.group.id}`;

/**
 * The rows in the order they had when the pointer came over the list (`held`, by key), so a row
 * never moves out from under it to put another in its place; a row new since then comes first.
 * Each row's state and words stay current.
 */
export function holdSpadeOrder(
  entries: readonly SpadeListEntry[],
  held: readonly string[],
): SpadeListEntry[] {
  const at = new Map(held.map((key, index) => [key, index]));
  const fresh = entries.filter((entry) => !at.has(spadeEntryKey(entry)));
  const kept = entries
    .filter((entry) => at.has(spadeEntryKey(entry)))
    .toSorted((a, b) => (at.get(spadeEntryKey(a)) ?? 0) - (at.get(spadeEntryKey(b)) ?? 0));
  return [...fresh, ...kept];
}

/** How many conversations wait on the person: the rail's needs-you dot while they're elsewhere. */
export function spadeNeedsYouCount(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
): number {
  return (
    bots.filter((bot) => spadeBotRow(bot).state === "needs-you").length +
    groups.filter((group) => spadeGroupRow(group).state === "needs-you").length
  );
}
