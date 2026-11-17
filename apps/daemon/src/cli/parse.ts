import type { CliErrorCode } from "@ace/protocol/cli-output";
import { globalFlags } from "./commands/globals.ts";
import type { AliasSpec, ArgSpec, CommandSpec, FlagSpec } from "./commands/spec.ts";
import type { CommandTable } from "./commands/table.ts";
import { nearest } from "./suggest.ts";

/** A command line read against the command table (ADR 0176 §1–§2). Pure. */
export interface Parsed {
  readonly kind: "command";
  readonly command: CommandSpec;
  /** The alias the person typed, when they didn't use the command's own words. */
  readonly alias?: AliasSpec;
  /** The words that named the command, as typed. */
  readonly typed: readonly string[];
  /** Positional arguments only, after the command's words. */
  readonly words: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
  /** Every value of a flag given more than once. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /** Required arguments not given; prompted for on a terminal, a usage error elsewhere. */
  readonly missing: readonly ArgSpec[];
}

/** A noun typed without a verb, when the noun has no default: its help is the answer. */
export interface NounOnly {
  readonly kind: "noun";
  readonly words: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

export interface UsageProblem {
  readonly kind: "usage";
  readonly code: CliErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly suggestion?: string;
  readonly argument?: string;
  readonly command?: string;
  readonly flags: Readonly<Record<string, string | true>>;
}

export type ParseResult = Parsed | NounOnly | UsageProblem;

const globalByName = new Map(globalFlags.map((flag) => [flag.name, flag]));
const globalByShort = new Map(
  globalFlags.flatMap((flag) => (flag.short ? [[flag.short, flag] as const] : [])),
);

export function parseCommandLine(table: CommandTable, input: readonly string[]): ParseResult {
  const flags: Record<string, string | true> = Object.create(null);
  const lists: Record<string, string[]> = Object.create(null);
  const usage = (
    code: CliErrorCode,
    message: string,
    extra: Partial<Omit<UsageProblem, "kind" | "code" | "message" | "flags">> = {},
  ): UsageProblem => ({ kind: "usage", code, message, flags, ...extra });

  // Global flags may come before the command's words.
  let i = 0;
  while (i < input.length && isFlag(input[i] ?? "")) {
    const taken = takeFlag(input, i, globalByName, globalByShort, flags, lists, {});
    if (typeof taken !== "number") return usage(taken.code, taken.message, taken);
    i = taken;
  }
  const start = i;
  while (i < input.length && !isFlag(input[i] ?? "") && input[i] !== "--") i++;
  const named = input.slice(start, i);

  let matched = 0;
  for (let k = named.length; k > 0; k--)
    if (table.routes.has(named.slice(0, k).join(" "))) {
      matched = k;
      break;
    }
  const typed = named.slice(0, matched);
  if (matched === 0 && named.length > 0) {
    const first = named[0] ?? "";
    if (table.next.get("")?.has(first)) return { kind: "noun", words: [first], flags };
    const suggestion = nearest(first, visibleWords(table, ""));
    return usage("unknown_command", `ace has no command ${first}.`, {
      ...(suggestion ? { suggestion: `ace ${suggestion}` } : {}),
      hint: suggestion ? `Did you mean ace ${suggestion}?` : "See every command with ace help.",
    });
  }
  const route = table.routes.get(typed.join(" "));
  if (!route) return usage("unknown_command", "ace has no such command.");
  let command = route.command;
  const alias = route.alias;
  const prefix = typed.join(" ");
  // A deeper noun typed alone (`ace provider account`) that has no default of its own.
  const extra = named[matched];
  if (extra !== undefined && table.next.has([...typed, extra].join(" ")) && !command.passthrough) {
    const deeper = [...typed, extra].join(" ");
    if (!table.routes.has(deeper)) return { kind: "noun", words: [...typed, extra], flags };
  }

  // `ace thread lsit` reaches the noun's default by its first word only; the second word
  // was meant as a verb.
  if (extra !== undefined && !route.alias && typed.length < command.words.length) {
    const verbs = visibleWords(table, prefix);
    const suggestion = nearest(extra, verbs);
    return usage("unknown_command", `ace ${prefix} has no command ${extra}.`, {
      ...(suggestion ? { suggestion: `ace ${prefix} ${suggestion}` } : {}),
      hint: suggestion
        ? `Did you mean ace ${prefix} ${suggestion}?`
        : `See what it can do with ace help ${prefix}.`,
    });
  }
  // An alias may send a flag to another command (`clean --compact`).
  for (const [flag, target] of Object.entries(alias?.byFlag ?? {}))
    if (input.slice(i).some((token) => token === `--${flag}` || token.startsWith(`--${flag}=`))) {
      const next = table.byId.get(target);
      if (next) command = next;
    }

  const words: string[] = [...(alias?.insertWords ?? []), ...named.slice(matched)];
  if (command.passthrough) {
    words.push(...input.slice(i).filter((token, index) => index > 0 || token !== "--"));
    return {
      kind: "command",
      command,
      ...(alias ? { alias } : {}),
      typed,
      words,
      flags,
      lists,
      missing: [],
    };
  }
  const own = new Map((command.flags ?? []).map((flag) => [flag.name, flag]));
  const byName = new Map([...globalByName, ...own]);
  const byShort = new Map([
    ...globalByShort,
    ...(command.flags ?? []).flatMap((flag) => (flag.short ? [[flag.short, flag] as const] : [])),
  ]);
  while (i < input.length) {
    const token = input[i] ?? "";
    if (token === "--") {
      words.push(...input.slice(i + 1));
      break;
    }
    if (!isFlag(token)) {
      words.push(token);
      i++;
      continue;
    }
    const taken = takeFlag(input, i, byName, byShort, flags, lists, alias?.renameFlags ?? {});
    if (typeof taken !== "number")
      return usage(taken.code, taken.message, { ...taken, command: command.id });
    i = taken;
  }
  for (const name of alias?.setFlags ?? []) flags[name] = true;
  for (const name of alias?.wordsAs ?? []) {
    const word = words.shift();
    if (word !== undefined && flags[name] === undefined) flags[name] = word;
  }

  const args = command.args ?? [];
  const variadic = args.some((arg) => arg.variadic);
  if (!variadic && words.length > args.length) {
    const takes =
      args.length === 0 ? "takes no arguments" : `takes ${args.map((arg) => arg.name).join(" ")}`;
    return usage(
      "too_many_arguments",
      `ace ${command.words.join(" ")} ${takes}, and ${words[args.length]} is one too many.`,
      {
        command: command.id,
        hint: `Quote text with spaces, or see ace help ${command.words.join(" ")}.`,
      },
    );
  }
  const missing = args.filter(
    (arg, index) => arg.required && words[index] === undefined && !(arg.variadic && index > 0),
  );
  return {
    kind: "command",
    command,
    ...(alias ? { alias } : {}),
    typed,
    words,
    flags,
    lists,
    missing,
  };
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--" && !/^-\d/.test(token);
}

interface FlagProblem {
  code: CliErrorCode;
  message: string;
  hint?: string;
  suggestion?: string;
  argument?: string;
}

/** Reads the flag at `index`; returns the next index, or the problem with it. */
function takeFlag(
  input: readonly string[],
  index: number,
  byName: ReadonlyMap<string, FlagSpec>,
  byShort: ReadonlyMap<string, FlagSpec>,
  flags: Record<string, string | true>,
  lists: Record<string, string[]>,
  renames: Readonly<Record<string, string>>,
): number | FlagProblem {
  const token = input[index] ?? "";
  const long = token.startsWith("--");
  const [rawName = "", ...rest] = token.slice(long ? 2 : 1).split("=");
  const inline = rest.length ? rest.join("=") : undefined;
  if (!long && rawName.length > 1 && inline === undefined) {
    // `-qy`: several one-letter switches together.
    const specs = [...rawName].map((letter) => byShort.get(letter));
    if (specs.every((spec) => spec && !spec.value)) {
      for (const spec of specs) if (spec) flags[spec.name] = true;
      return index + 1;
    }
  }
  const name = renames[rawName] ?? rawName;
  const spec = long ? byName.get(name) : byShort.get(name);
  if (!spec) {
    const known = [...byName.values()].filter((flag) => !flag.hidden).map((flag) => flag.name);
    const suggestion = long ? nearest(name, known) : undefined;
    return {
      code: "unknown_flag",
      message: `${token.split("=")[0]} isn't a flag this command takes.`,
      argument: token.split("=")[0] ?? token,
      ...(suggestion ? { suggestion: `--${suggestion}` } : {}),
      hint: suggestion ? `Did you mean --${suggestion}?` : "See its flags with --help.",
    };
  }
  const shown = `--${spec.name}`;
  if (!spec.value) {
    if (inline !== undefined)
      return { code: "bad_argument", message: `${shown} takes no value.`, argument: shown };
    if (flags[spec.name] !== undefined && !spec.repeat)
      return { code: "bad_argument", message: `${shown} is given twice.`, argument: shown };
    flags[spec.name] = true;
    return index + 1;
  }
  const value = inline ?? input[index + 1];
  if (value === undefined || (inline === undefined && value.startsWith("--")))
    return {
      code: "missing_argument",
      message: `${shown} needs a value: ${spec.value}.`,
      argument: shown,
    };
  if (spec.choices && !spec.choices.includes(value))
    return {
      code: "bad_argument",
      message: `${shown} takes ${spec.choices.join(", ")}, not ${value}.`,
      argument: shown,
    };
  if (spec.repeat) (lists[spec.name] ??= []).push(value);
  else if (flags[spec.name] !== undefined)
    return { code: "bad_argument", message: `${shown} is given twice.`, argument: shown };
  flags[spec.name] = value;
  return index + (inline === undefined ? 2 : 1);
}

/** The words that may follow a prefix, without hidden commands or old spellings. */
export function visibleWords(table: CommandTable, prefix: string): string[] {
  const depth = prefix ? prefix.split(" ").length : 0;
  const visible = new Set<string>();
  for (const [key, route] of table.routes) {
    if (route.command.hidden || route.alias?.deprecatedSince || route.alias?.quiet) continue;
    const words = key.split(" ");
    if (words.length <= depth || (prefix && !key.startsWith(`${prefix} `))) continue;
    visible.add(words[depth] ?? "");
  }
  return [...visible].filter(Boolean).toSorted();
}
