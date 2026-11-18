import { CliFailure, usageFailure } from "../output.ts";

/** The shortest prefix a reference may use (ADR 0178 §1 rule 5). */
export const shortestPrefix = 6;

export interface RefNoun {
  /** "thread", "request": the noun in sentences. */
  readonly noun: string;
  /** "THREAD", "REQUEST": the argument the error names. */
  readonly argument: string;
  /** The command that lists them, for the hint. */
  readonly list: string;
}

export const threadNoun: RefNoun = {
  noun: "thread",
  argument: "THREAD",
  list: "ace thread list",
};
export const requestNoun: RefNoun = {
  noun: "request",
  argument: "REQUEST",
  list: "ace request list",
};

/**
 * Which id `input` names among `known`: the id itself, or an unambiguous prefix of at least six
 * characters. An ambiguous prefix fails naming the matches. When nothing known matches,
 * `passThrough` keeps a whole id the caller can't see listed (a child thread, an older thread
 * past the loaded page) for the daemon to judge; otherwise it is not found. Pure.
 */
export function resolveRef(
  input: string,
  known: readonly string[],
  noun: RefNoun,
  passThrough: (input: string) => boolean = () => false,
): string {
  const value = input.trim();
  if (known.includes(value)) return value;
  if (value.length < shortestPrefix)
    throw usageFailure(
      `${noun.argument} must be a ${noun.noun} id or at least ${shortestPrefix} characters of one.`,
      { argument: noun.argument, hint: `See the ids with ${noun.list}.` },
    );
  const matches = [...new Set(known.filter((id) => id.startsWith(value)))];
  if (matches.length === 1) return matches[0] ?? value;
  if (matches.length > 1) {
    const shown = matches.slice(0, 3).join(", ");
    const more = matches.length > 3 ? ` and ${matches.length - 3} more` : "";
    throw usageFailure(`${value} could be ${matches.length} ${noun.noun}s: ${shown}${more}.`, {
      code: "ambiguous",
      argument: noun.argument,
      hint: "Type more of the id.",
    });
  }
  if (passThrough(value)) return value;
  throw notFound(value, noun);
}

export function notFound(value: string, noun: RefNoun): CliFailure {
  return new CliFailure("refused", `No ${noun.noun} starting with ${value}.`, undefined, {
    code: "not_found",
    argument: noun.argument,
    hint: `See them with ${noun.list}.`,
  });
}

/**
 * The shortest prefix of each id, at least `floor` characters, that no other listed id shares:
 * what a list shows so each id can be typed back. Pure.
 */
export function shortIds(ids: readonly string[], floor = 8): Map<string, string> {
  const sorted = [...new Set(ids)].toSorted();
  const short = new Map<string, string>();
  for (const [index, id] of sorted.entries()) {
    const shared = Math.max(
      common(id, sorted[index - 1] ?? ""),
      common(id, sorted[index + 1] ?? ""),
    );
    short.set(id, id.slice(0, Math.max(floor, shared + 1)));
  }
  return short;
}

function common(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return at;
}
