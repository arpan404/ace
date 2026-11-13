import type { RosterBot } from "./use-spade-roster.ts";
import type { RosterGroup } from "./use-spade-groups.ts";

/*
 * Which of Spade's list shows: every bot, the ones working, the ones that need the person, or
 * those on one machine; then what the search names, in a bot's name, its few words, its problem
 * or its latest message (a group's name, members and latest message).
 */

/** `all`, `working`, `needs-you`, or `machine:<key>`. */
export type SpadeListFilter = "all" | "working" | "needs-you" | `machine:${string}`;

type Entry = { kind: "bot"; bot: RosterBot } | { kind: "group"; group: RosterGroup };

const needsYou = (bot: RosterBot) =>
  !bot.away && !bot.unavailable && (bot.state === "waiting" || bot.problem !== undefined);
const working = (bot: RosterBot) => !bot.away && !bot.unavailable && bot.state === "working";

function machineOf(entry: Entry): string {
  return entry.kind === "bot" ? entry.bot.machine.key : entry.group.machine.key;
}

function stateMatches(entry: Entry, filter: SpadeListFilter): boolean {
  if (filter === "all") return true;
  if (filter.startsWith("machine:")) return machineOf(entry) === filter.slice("machine:".length);
  if (entry.kind === "group")
    return filter === "working" ? entry.group.state === "working" : entry.group.state === "waiting";
  return filter === "working" ? working(entry.bot) : needsYou(entry.bot);
}

function words(entry: Entry): string[] {
  if (entry.kind === "bot") {
    const { bot } = entry;
    return [bot.name, bot.status, bot.problem, bot.lastMessage?.text].filter(
      (text): text is string => text !== undefined,
    );
  }
  const { group } = entry;
  return [
    group.name,
    group.status,
    group.lastMessage?.text,
    ...group.members.map((member) => member.name),
  ].filter((text): text is string => text !== undefined);
}

export function filterSpadeList<T extends Entry>(
  entries: readonly T[],
  filter: SpadeListFilter,
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      stateMatches(entry, filter) &&
      (!needle || words(entry).some((text) => text.toLocaleLowerCase().includes(needle))),
  );
}

/** How many bots each state filter would show. */
export function spadeListCounts(bots: readonly RosterBot[]) {
  return {
    all: bots.length,
    working: bots.filter(working).length,
    needsYou: bots.filter(needsYou).length,
  };
}
