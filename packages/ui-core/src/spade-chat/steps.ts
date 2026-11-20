import type { SpadeCallState, SpadeReplyEntry, SpadeReplyPart } from "./fold.ts";
import { spadeToolWords } from "./words.ts";

/*
 * The steps a reply took, folded into one quiet line under it ("Ran 3 commands, changed 2
 * files") that opens to each step: what ran, where, and how it ended (docs/design/spade.md §3).
 * A step the person must see without opening anything stands under the line as it is: one the
 * sandbox's network policy blocked, the review refused or the person declined, one that deletes
 * or can't be undone, and one that acted outside the bot's box (it ran outside the sandbox,
 * reached the network, pushed, commented or sent). Pure, so every client reads steps the same.
 */

export interface SpadeStep {
  /** The call's id. */
  key: string;
  /** "Ran a command", "Didn't send an email". */
  line: string;
  /** One line of what it touched: the command, a file's path, a page's address. */
  detail: string | undefined;
  /** Where and how, in order: "In its sandbox", "You allowed it", "Exit code 2", "Hard to undo". */
  meta: readonly string[];
  /** What the network policy refused it, each said plainly: "Blocked example.com: …". */
  blocked: readonly string[];
  /** It shows under the folded line without opening it. */
  notable: boolean;
}

export interface SpadeSteps {
  /** "Ran 3 commands, changed 2 files", "Searched the web twice". */
  summary: string;
  /** Every finished step, in the order taken. */
  steps: readonly SpadeStep[];
}

/**
 * Calls the chat already shows in their own way: a card, a helper's line, a skill's bubble, a
 * note it saved (ADR 0128), and what it showed the person (ADR 0134).
 */
const shownElsewhere = new Set([
  "ask_user",
  "helper",
  "skill_propose",
  "memory_save",
  "memory_update",
  "memory_forget",
  "image_generate",
  "share_file",
  // A bot changing its own task, name or face: its own quiet line (`task-changed`, `named`).
  "task_update",
  "profile_update",
  // A bot made for the person, or added to a club: their own lines (`made`, `club-added`).
  "club_add",
]);

/** A call that has finished one way or another; one still going is the working line's. */
const settled = new Set<SpadeCallState>(["done", "failed", "declined", "refused", "skipped"]);

const baseName = (name: string) => name.split("__").at(-1) ?? name;

type CallPart = Extract<SpadeReplyPart, { kind: "call" }>;

/** A reply's finished steps folded into one line; undefined while it has none. */
export function spadeReplySteps(entry: SpadeReplyEntry): SpadeSteps | undefined {
  // How the person answered each call that asked them, by its id.
  const answers = new Map<string, "allowed" | "denied">();
  for (const part of entry.parts)
    if (part.kind === "request" && part.answer) answers.set(part.callId, part.answer);
  const steps: SpadeStep[] = [];
  for (const part of entry.parts) {
    if (part.kind !== "call" || !settled.has(part.state)) continue;
    if (shownElsewhere.has(baseName(part.name))) continue;
    steps.push(stepOf(part, answers.get(part.key)));
  }
  if (!steps.length) return undefined;
  return { summary: spadeStepsSummary(steps), steps };
}

/**
 * What the open reply's newest running call touches (its command, a file's path, a page's
 * address), for the working line beside its words; undefined when nothing runs or it has no
 * detail.
 */
export function spadeRunningDetail(entry: SpadeReplyEntry | undefined): string | undefined {
  if (!entry || entry.end) return undefined;
  for (let at = entry.parts.length - 1; at >= 0; at--) {
    const part = entry.parts[at];
    if (part?.kind !== "call" || part.state !== "running") continue;
    if (shownElsewhere.has(baseName(part.name))) return undefined;
    return part.detail;
  }
  return undefined;
}

function stepOf(part: CallPart, answer: "allowed" | "denied" | undefined): SpadeStep {
  const words = spadeToolWords(part.name);
  const ran = part.state === "done" || part.state === "failed";
  const meta: string[] = [];
  const { ran: command } = part;
  if (command?.contained !== undefined)
    meta.push(command.contained ? "In its sandbox" : "Outside its sandbox");
  if (answer === "allowed" && ran) meta.push("You allowed it");
  meta.push(...outcome(part));
  if (command?.reached.length) meta.push(`Reached ${listed(command.reached)}`);
  if (part.weight === "destructive" && ran) meta.push("Hard to undo");
  const blocked = (command?.refused ?? []).map(
    (refused) => `Blocked ${refused.host}${because(refused.host, refused.reason)}`,
  );
  return {
    key: part.key,
    line: ran ? words.done : `Didn't ${words.base}`,
    detail: part.detail,
    meta,
    blocked,
    notable:
      blocked.length > 0 ||
      part.state === "refused" ||
      part.state === "declined" ||
      (ran && part.weight !== undefined) ||
      command?.contained === false ||
      (command?.reached.length ?? 0) > 0,
  };
}

/** How a step ended, in words; nothing when "Ran a command" already says it went fine. */
function outcome(part: CallPart): string[] {
  switch (part.state) {
    case "declined":
      return ["You declined it"];
    case "refused":
      return [part.reason ? `The review refused it: ${part.reason}` : "The review refused it"];
    case "skipped":
      return ["The reply ended first"];
    default:
      break;
  }
  const command = part.ran;
  if (command?.timedOut) return ["Stopped at its deadline"];
  if (command)
    return [command.exitCode === undefined ? "Ended by a signal" : `Exit code ${command.exitCode}`];
  return part.state === "failed" ? ["Failed"] : [];
}

/** Why a host was refused, without its name said twice: ": not on this bot's network allow-list". */
function because(host: string, reason: string): string {
  const said = reason.trim().replace(/\.$/, "");
  if (!said) return "";
  const rest = said.startsWith(`${host} `) ? said.slice(host.length + 1) : said;
  return `: ${rest.replace(/^is /, "")}`;
}

/** "a.com", "a.com and b.com", "a.com, b.com and 3 more". */
function listed(hosts: readonly string[]): string {
  if (hosts.length <= 2) return hosts.join(" and ");
  return `${hosts.slice(0, 2).join(", ")} and ${hosts.length - 2} more`;
}

/** How many kinds of step the line names before "and 3 more". */
const named = 3;

/**
 * The folded line: like steps counted together, in the order they first came. "Ran 7 commands,
 * wrote a file", "Searched the web twice", "Read 2 files, ran a command, wrote a file and 4 more".
 */
export function spadeStepsSummary(steps: readonly Pick<SpadeStep, "line">[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.line, (counts.get(step.line) ?? 0) + 1);
  const groups = [...counts];
  const phrases = groups
    .slice(0, named)
    .map(([line, count], index) =>
      index ? lowerFirst(counted(line, count)) : counted(line, count),
    );
  const rest = groups.slice(named).reduce((sum, [, count]) => sum + count, 0);
  const listedPhrases = phrases.join(", ");
  return rest ? `${listedPhrases} and ${rest} more` : listedPhrases;
}

/** "Ran a command" ×3 → "Ran 3 commands"; "Searched the web" ×2 → "Searched the web twice". */
function counted(line: string, count: number): string {
  if (count === 1) return line;
  const article = /^(.*?) (?:a|an) (.+)$/.exec(line);
  if (!article) return `${line} ${count === 2 ? "twice" : `${count} times`}`;
  const [, before, thing = ""] = article;
  // The thing's own words end at its first preposition: "message to a thread".
  const tail = /^(.*?)( (?:to|for|from|on|in|about|with) .*)?$/.exec(thing);
  const head = tail?.[1] ?? thing;
  return `${before} ${count} ${plural(head)}${tail?.[2] ?? ""}`;
}

/** The last word of `words` in its plural. */
function plural(words: string): string {
  if (/(?:s|sh|ch|x|z)$/.test(words)) return `${words}es`;
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`;
  return `${words}s`;
}

/** A line after a comma starts lower case. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
