import {
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
  | { kind: "bot"; bot: RosterBot; row: SpadeRow }
  | { kind: "group"; group: RosterGroup; row: SpadeRow };

const activity = (entry: SpadeListEntry) =>
  entry.kind === "bot" ? entry.bot.lastActivity : entry.group.lastActivity;

const botEntry = (bot: RosterBot): SpadeListEntry => ({ kind: "bot", bot, row: spadeBotRow(bot) });

/**
 * The list's rows: Spade, the main bot, first as an ordinary row, then every other bot and every
 * group by state, newest first within one.
 */
export function spadeListEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
): SpadeListEntry[] {
  const others: SpadeListEntry[] = [
    ...bots.filter((bot) => bot.kind !== "main").map(botEntry),
    ...groups.map((group) => ({ kind: "group" as const, group, row: spadeGroupRow(group) })),
  ];
  const main = bots.filter((bot) => bot.kind === "main").map(botEntry);
  return [
    ...main,
    ...others.toSorted(
      (a, b) => rank[a.row.state] - rank[b.row.state] || activity(b) - activity(a),
    ),
  ];
}

/** When the person pinned the conversation (ms); undefined when it isn't pinned. */
export const pinnedAt = (entry: SpadeListEntry): number | undefined =>
  entry.kind === "bot" ? entry.bot.pinnedAt : entry.group.pinnedAt;

/**
 * The pinned conversations, oldest pin first, which show as a strip under the list's buttons,
 * and the rest, which stay in the rows below in their order.
 */
export function splitPinned(entries: readonly SpadeListEntry[]): {
  pinned: SpadeListEntry[];
  rest: SpadeListEntry[];
} {
  const pinned = entries.filter((entry) => pinnedAt(entry) !== undefined);
  return {
    pinned: pinned.toSorted((a, b) => (pinnedAt(a) ?? 0) - (pinnedAt(b) ?? 0)),
    rest: entries.filter((entry) => pinnedAt(entry) === undefined),
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
