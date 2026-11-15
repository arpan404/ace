import type { SpadeCallState, SpadeReplyEntry } from "./fold.ts";
import { spadeCallLine } from "./words.ts";

/*
 * The steps a reply took, folded into one line under it ("Ran 7 commands, wrote a file") that
 * opens to each step. Pure, so every client reads a reply's steps the same way.
 *
 * This is the one seam for where steps come from. Today a reply's own calls are its steps (the
 * fold keeps each call in the reply that made it), each in the words a call reads in. When Spade
 * stores each step's sentence and detail with the reply it led to, only `spadeReplySteps` changes.
 */

export interface SpadeStep {
  /** The call's id. */
  key: string;
  /** "Ran a command", "Couldn't read a file", "You declined: send an email". */
  line: string;
  /** One line of what it touched ("gh pr list --state open"); undefined until Spade says. */
  detail: string | undefined;
}

/** Calls the chat already shows in their own way: a card, a helper's line, a skill's bubble. */
const shownElsewhere = new Set(["ask_user", "helper", "skill_propose"]);

/** A call that has finished one way or another; one still going is the working line's. */
const settled = new Set<SpadeCallState>(["done", "failed", "declined", "skipped"]);

const baseName = (name: string) => name.split("__").at(-1) ?? name;

/** A reply's finished steps, in the order it took them. */
export function spadeReplySteps(entry: SpadeReplyEntry): SpadeStep[] {
  const steps: SpadeStep[] = [];
  for (const part of entry.parts) {
    if (part.kind !== "call" || !settled.has(part.state)) continue;
    if (shownElsewhere.has(baseName(part.name))) continue;
    steps.push({ key: part.key, line: spadeCallLine(part.name, part.state), detail: undefined });
  }
  return steps;
}

/** How many kinds of step the line names before "and 3 more". */
const named = 3;

/**
 * The folded line: like steps counted together, in the order they first came. "Ran 7 commands,
 * wrote a file", "Searched the web twice", "Read 2 files, ran a command, wrote a file and 4 more".
 */
export function spadeStepsSummary(steps: readonly SpadeStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.line, (counts.get(step.line) ?? 0) + 1);
  const groups = [...counts];
  const phrases = groups
    .slice(0, named)
    .map(([line, count], index) => (index ? lowerFirst(counted(line, count)) : counted(line, count)));
  const rest = groups.slice(named).reduce((sum, [, count]) => sum + count, 0);
  const listed = phrases.join(", ");
  return rest ? `${listed} and ${rest} more` : listed;
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
