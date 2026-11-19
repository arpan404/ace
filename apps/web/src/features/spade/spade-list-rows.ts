import { spadeBotRow, spadeGroupRow, spadeByState, type SpadeRow } from "@ace/ui-core/spade-chat";
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

/** The bots in the list that made this one, if its maker is among them. */
function makerOf(bot: RosterBot, byKey: ReadonlyMap<string, RosterBot>): RosterBot | undefined {
  return bot.parent ? byKey.get(`${bot.machine.key}/${bot.parent.id}`) : undefined;
}

/** Spade, the main bot, first as an ordinary row, then the rest by state, newest first. */
function topLevel(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  missing: SpadeGoalMissing | undefined,
): SpadeListEntry[] {
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
 * Every row in the list's order with no nesting, workers among the rest: what the search looks
 * through, and where a pinned worker comes from while its family is folded.
 */
export function spadeFlatEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  missing?: SpadeGoalMissing,
): SpadeListEntry[] {
  return topLevel(bots, groups, missing);
}

/**
 * The list's rows: Spade, the main bot, first as an ordinary row, then every other bot and every
 * group by state, newest first within one. A bot another bot made nests under its maker while the
 * maker or one of its workers is the open conversation (`open`, a bot id); while the family is
 * folded only a worker that needs the person or failed shows, raised under its maker, which
 * carries the rest in its own state. A worker whose maker isn't in the list shows as any bot.
 */
export function spadeListEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
  open?: string,
  missing?: SpadeGoalMissing,
): SpadeListEntry[] {
  const byKey = new Map(bots.map((bot) => [botKey(bot), bot]));
  const workersOf = new Map<string, RosterBot[]>();
  const roots: RosterBot[] = [];
  for (const bot of bots) {
    const maker = bot.kind === "main" ? undefined : makerOf(bot, byKey);
    if (!maker) {
      roots.push(bot);
      continue;
    }
    workersOf.set(botKey(maker), [...(workersOf.get(botKey(maker)) ?? []), bot]);
  }
  const descendants = (bot: RosterBot, seen: Set<string>): RosterBot[] => {
    const found: RosterBot[] = [];
    for (const worker of workersOf.get(botKey(bot)) ?? []) {
      if (seen.has(botKey(worker))) continue;
      seen.add(botKey(worker));
      found.push(worker, ...descendants(worker, seen));
    }
    return found;
  };
  const familyOf = (root: RosterBot) => descendants(root, new Set([botKey(root)]));
  // Makers that made each other have no root: the first of them stands in as one.
  const reached = new Set<string>();
  for (const root of roots) {
    reached.add(botKey(root));
    for (const member of familyOf(root)) reached.add(botKey(member));
  }
  for (const bot of bots) {
    if (reached.has(botKey(bot))) continue;
    roots.push(bot);
    reached.add(botKey(bot));
    for (const member of familyOf(bot)) reached.add(botKey(member));
  }
  const rootKeys = new Set(roots.map(botKey));
  const rows: SpadeListEntry[] = [];
  for (const entry of topLevel(roots, groups, missing)) {
    if (entry.kind !== "bot" || !rootKeys.has(botKey(entry.bot))) {
      rows.push(entry);
      continue;
    }
    const family = familyOf(entry.bot);
    const unfolded = open !== undefined && [entry.bot, ...family].some((bot) => bot.id === open);
    const shown = family
      .map((bot) => botEntry(bot, missing, 1))
      .filter(
        (worker) => unfolded || worker.row.state === "needs-you" || worker.row.state === "failed",
      );
    rows.push(entry, ...byState(shown));
  }
  return rows;
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
 * The pinned conversations, oldest pin first, which show as a strip under the list's buttons,
 * and the rest of `entries`, which stay in the rows below in their order. The strip draws on
 * `all`, so a pinned worker shows there while its family is folded.
 */
export function splitPinned(
  entries: readonly SpadeListEntry[],
  all: readonly SpadeListEntry[] = entries,
): {
  pinned: SpadeListEntry[];
  rest: SpadeListEntry[];
} {
  const pinned = all.filter((entry) => pinnedAt(entry) !== undefined);
  const pinnedBots = new Set(
    pinned.flatMap((entry) => (entry.kind === "bot" ? [botKey(entry.bot)] : [])),
  );
  return {
    pinned: pinned.toSorted((a, b) => (pinnedAt(a) ?? 0) - (pinnedAt(b) ?? 0)),
    rest: entries
      .filter((entry) => pinnedAt(entry) === undefined)
      // A worker whose maker moved to the strip has no row to nest under.
      .map((entry): SpadeListEntry => {
        if (
          entry.kind === "bot" &&
          entry.depth === 1 &&
          entry.bot.parent &&
          pinnedBots.has(`${entry.bot.machine.key}/${entry.bot.parent.id}`)
        )
          return Object.assign({}, entry, { depth: 0 });
        return entry;
      }),
  };
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
