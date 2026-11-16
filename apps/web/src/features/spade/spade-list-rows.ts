import {
  spadeCappedLine,
  spadeForLaterWords,
  spadeGroupLine,
  spadeProblemStep,
  spadeTaskLine,
} from "@ace/ui-core/spade-chat";
import type { RosterBot } from "./use-spade-roster.ts";
import type { RosterGroup } from "./use-spade-groups.ts";

/*
 * What Spade's list says about each conversation (docs/design/spade.md §2): its state, which
 * picks the face's pose, its dot and its line's colour; its one line; and where it sits. Spade
 * sends each latest message as a plain-text preview and says which conversations finished
 * unseen (its seen cursor). Pure, so the rules are tested directly.
 */

/**
 * A row's state, in the order the list sorts by: needs you, working, failed, finished and not
 * seen, then the rest. `off` (its machine offline or its Spade not running) sorts with the rest.
 */
export type SpadeRowState = "needs-you" | "working" | "failed" | "unseen" | "rest" | "off";

const rank: Record<SpadeRowState, number> = {
  "needs-you": 0,
  working: 1,
  failed: 2,
  unseen: 3,
  rest: 4,
  off: 4,
};

export interface SpadeRow {
  state: SpadeRowState;
  line: string;
}

/** Off here or on the machine named (ace runs on more than Macs); its machine offline says so. */
function offLine(entry: { away: boolean; machine: { primary: boolean; name: string } }): string {
  if (entry.away) return `${entry.machine.name} is offline`;
  return entry.machine.primary ? "Off on this machine" : `Off on ${entry.machine.name}`;
}

function lastLine(bot: RosterBot): string {
  const last = bot.lastMessage;
  const text = last?.text ?? "";
  if (!last || !text) return "No messages yet";
  if (last.from === "agent") return text;
  return `${last.fromAgent ? last.fromAgent.name : "You"}: ${text}`;
}

/** A bot's row: what needs the person first, then what it does, what broke, else its last word. */
export function spadeBotRow(bot: RosterBot): SpadeRow {
  if (bot.away || bot.unavailable) return { state: "off", line: offLine(bot) };
  if (bot.state === "waiting")
    return {
      state: "needs-you",
      line: bot.waitingFor === "question" ? "Asked you a question" : (bot.status ?? "Needs you"),
    };
  // The person has its computer: Spade pauses it until they hand it back.
  if (bot.computer?.driver === "person")
    return { state: "rest", line: "Paused while you have the computer" };
  // A task it carries on by itself, or one that waits on the person, in its chat's words.
  const task = spadeTaskLine(bot.name, bot.progress, bot.status);
  if (task?.tone === "needs-you") return { state: "needs-you", line: task.step ?? "Needs you" };
  // Waiting on a job, another bot or its next step's time: nothing for the person to do.
  if (task?.tone === "waiting")
    return { state: "rest", line: ["Waiting", task.step].filter(Boolean).join(" · ") };
  if (task) return { state: "working", line: task.step ?? bot.status ?? "Working on it" };
  if (bot.state === "working") return { state: "working", line: bot.status ?? "Working" };
  // A subscription that couldn't run (signed out, out of quota): its next step in a few words.
  if (bot.problem) return { state: "failed", line: spadeProblemStep(bot.problem) };
  const state = bot.unseen ? "unseen" : "rest";
  // Cards left for later wait on nothing: a quiet count, never the needs-you colour (ADR 0154).
  if (bot.questionsForLater > 0) return { state, line: spadeForLaterWords(bot.questionsForLater) };
  // At a cap it makes no model call until the cap ends (ADR 0135).
  if (bot.spending?.capped) return { state, line: spadeCappedLine(bot.spending.capped) };
  return { state, line: lastLine(bot) };
}

/** A group's row: what it waits on or does, else its last speaker named, then their words. */
export function spadeGroupRow(group: RosterGroup): SpadeRow {
  if (group.away || group.unavailable) return { state: "off", line: offLine(group) };
  const said = spadeGroupLine(group);
  if (group.state === "waiting") return { state: "needs-you", line: said.text };
  if (group.state === "working") return { state: "working", line: said.text };
  return { state: group.unseen ? "unseen" : "rest", line: said.text };
}

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

const botEntry = (bot: RosterBot, depth: 0 | 1 = 0): SpadeListEntry => ({
  kind: "bot",
  bot,
  row: spadeBotRow(bot),
  depth,
});

const byState = (a: SpadeListEntry, b: SpadeListEntry) =>
  rank[a.row.state] - rank[b.row.state] || activity(b) - activity(a);

/** A bot's key across machines: ids repeat between machines' Spades. */
const botKey = (bot: RosterBot) => `${bot.machine.key}/${bot.id}`;

/** The bots in the list that made this one, if its maker is among them. */
function makerOf(bot: RosterBot, byKey: ReadonlyMap<string, RosterBot>): RosterBot | undefined {
  return bot.parent ? byKey.get(`${bot.machine.key}/${bot.parent.id}`) : undefined;
}

/** Spade, the main bot, first as an ordinary row, then the rest by state, newest first. */
function topLevel(bots: readonly RosterBot[], groups: readonly RosterGroup[]): SpadeListEntry[] {
  const others: SpadeListEntry[] = [
    ...bots.filter((bot) => bot.kind !== "main").map((bot) => botEntry(bot)),
    ...groups.map((group) => ({
      kind: "group" as const,
      group,
      row: spadeGroupRow(group),
      depth: 0 as const,
    })),
  ];
  const main = bots.filter((bot) => bot.kind === "main").map((bot) => botEntry(bot));
  return [...main, ...others.toSorted(byState)];
}

/**
 * Every row in the list's order with no nesting, workers among the rest: what the search looks
 * through, and where a pinned worker comes from while its family is folded.
 */
export function spadeFlatEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
): SpadeListEntry[] {
  return topLevel(bots, groups);
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
  const descendants = (bot: RosterBot, seen: Set<string>): RosterBot[] =>
    (workersOf.get(botKey(bot)) ?? []).flatMap((worker) =>
      seen.has(botKey(worker)) ? [] : [worker, ...descendants(worker, seen.add(botKey(worker)))],
    );
  const familyOf = (root: RosterBot) => descendants(root, new Set([botKey(root)]));
  // Makers that made each other have no root: the first of them stands in as one.
  const reached = new Set(roots.flatMap((root) => [root, ...familyOf(root)].map(botKey)));
  for (const bot of bots) {
    if (reached.has(botKey(bot))) continue;
    roots.push(bot);
    for (const member of [bot, ...familyOf(bot)]) reached.add(botKey(member));
  }
  const rootKeys = new Set(roots.map(botKey));
  return topLevel(roots, groups).flatMap((entry) => {
    if (entry.kind !== "bot" || !rootKeys.has(botKey(entry.bot))) return [entry];
    const family = familyOf(entry.bot);
    const unfolded = open !== undefined && [entry.bot, ...family].some((bot) => bot.id === open);
    const shown = family
      .map((bot) => botEntry(bot, 1))
      .filter(
        (worker) => unfolded || worker.row.state === "needs-you" || worker.row.state === "failed",
      );
    return [entry, ...shown.toSorted(byState)];
  });
}

/** When the person pinned the conversation (ms); undefined when it isn't pinned. */
export const pinnedAt = (entry: SpadeListEntry): number | undefined =>
  entry.kind === "bot" ? entry.bot.pinnedAt : entry.group.pinnedAt;

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
      .map((entry): SpadeListEntry =>
        entry.kind === "bot" &&
        entry.depth === 1 &&
        entry.bot.parent &&
        pinnedBots.has(`${entry.bot.machine.key}/${entry.bot.parent.id}`)
          ? { ...entry, depth: 0 }
          : entry,
      ),
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
