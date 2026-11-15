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
 * picks the face's pose, its dot and its line's colour; its one line; and where it sits. Pure, so
 * the rules are tested directly.
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

/*
 * The seam to Spade's messenger fields, until every Spade sends them. `unseen` (the bot finished
 * and the person hasn't opened it since) is read off the agent as Spade sent it; a Spade before
 * the seen cursor sends none, and then everything counts as seen. Previews arrive as plain text
 * from such a Spade; one before that may send markdown, so the list strips it either way.
 */

/** The bot or group finished something the person hasn't seen; false when Spade doesn't say. */
export function unseenOf(entry: RosterBot | RosterGroup): boolean {
  // Groups don't carry Spade's raw fields yet: until they do, a group counts as seen.
  return "raw" in entry && entry.raw.unseen === true;
}

/**
 * A message as one plain line: markdown's marks gone (emphasis, headings, quotes, fences, list
 * marks, strike-through, inline code ticks), links and images as their words, whitespace folded.
 */
export function plainPreview(text: string): string {
  return (
    text
      // Fences and their language, keeping what they hold.
      .replaceAll(/```[^\n]*\n?/g, " ")
      // Images and links as their words; a bare autolink as its address.
      .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replaceAll(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      // Line starts: headings, quotes, list marks, task boxes, rules.
      .replaceAll(
        /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm,
        "",
      )
      .replaceAll(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, " ")
      // Emphasis, strike-through and code ticks around words.
      .replaceAll(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replaceAll(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2")
      .replaceAll(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
      .replaceAll(/`([^`]+)`/g, "$1")
      .replaceAll(/\s+/g, " ")
      .trim()
  );
}

/** Off here or on the machine named (ace runs on more than Macs); its machine offline says so. */
function offLine(entry: { away: boolean; machine: { primary: boolean; name: string } }): string {
  if (entry.away) return `${entry.machine.name} is offline`;
  return entry.machine.primary ? "Off on this machine" : `Off on ${entry.machine.name}`;
}

function lastLine(bot: RosterBot): string {
  const last = bot.lastMessage;
  const text = last?.text ? plainPreview(last.text) : "";
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
  const state = unseenOf(bot) ? "unseen" : "rest";
  // Cards left for later wait on nothing: a quiet count, never the needs-you colour (ADR 0154).
  if (bot.questionsForLater > 0) return { state, line: spadeForLaterWords(bot.questionsForLater) };
  // At a cap it makes no model call until the cap ends (ADR 0135).
  if (bot.spending?.capped) return { state, line: spadeCappedLine(bot.spending.capped) };
  return { state, line: lastLine(bot) };
}

/** A group's row: what it waits on or does, else its last speaker named, then their words. */
export function spadeGroupRow(group: RosterGroup): SpadeRow {
  if (group.away || group.unavailable) return { state: "off", line: offLine(group) };
  const last = group.lastMessage;
  const said = spadeGroupLine(
    last ? { ...group, lastMessage: { ...last, text: plainPreview(last.text) } } : group,
  );
  if (group.state === "waiting") return { state: "needs-you", line: said.text };
  if (group.state === "working") return { state: "working", line: said.text };
  return { state: unseenOf(group) ? "unseen" : "rest", line: said.text };
}

export type SpadeListEntry =
  | { kind: "bot"; bot: RosterBot; row: SpadeRow }
  | { kind: "group"; group: RosterGroup; row: SpadeRow };

const activity = (entry: SpadeListEntry) =>
  entry.kind === "bot" ? entry.bot.lastActivity : entry.group.lastActivity;

/**
 * The rows under Spade's head: every bot but Spade (the head) and every group, by state, then
 * newest first within one.
 */
export function spadeListEntries(
  bots: readonly RosterBot[],
  groups: readonly RosterGroup[],
): SpadeListEntry[] {
  const entries: SpadeListEntry[] = [
    ...bots
      .filter((bot) => bot.kind !== "main")
      .map((bot) => ({ kind: "bot" as const, bot, row: spadeBotRow(bot) })),
    ...groups.map((group) => ({ kind: "group" as const, group, row: spadeGroupRow(group) })),
  ];
  return entries.toSorted(
    (a, b) => rank[a.row.state] - rank[b.row.state] || activity(b) - activity(a),
  );
}

function words(entry: SpadeListEntry): string[] {
  const said = entry.kind === "bot" ? entry.bot.lastMessage?.text : entry.group.lastMessage?.text;
  const named =
    entry.kind === "bot"
      ? [entry.bot.name]
      : [entry.group.name, ...entry.group.members.map((member) => member.name)];
  return [...named, entry.row.line, said === undefined ? "" : plainPreview(said)];
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
