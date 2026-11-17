import { globalFlags } from "../commands/globals.ts";
import type { CommandGroup, CommandSpec, FlagSpec } from "../commands/spec.ts";
import type { CommandTable } from "../commands/table.ts";
import { exitCodeMeanings } from "./topics.ts";

/** `ace help` pages, from the command table (ADR 0176 §5). Pure: table in, text out. */

export const groupTitles: Record<CommandGroup, string> = {
  basics: "Start",
  work: "Work",
  machine: "This machine",
  providers: "Providers and access",
  "spade-market": "Spade and the market",
  "agent-tools": "Agent tools",
};

const shortcuts: readonly { command: string; summary: string }[] = [
  { command: "ace", summary: "The interactive home, on a terminal" },
  { command: "ace run PROMPT", summary: "Start an agent in this folder" },
  { command: "ace chat [THREAD]", summary: "Talk with an agent here" },
  { command: "ace status", summary: "What runs and what needs you" },
  { command: "ace open [PATH]", summary: "Open a project in the app" },
  { command: "ace login", summary: "Sign this machine in to ace" },
];

export function overview(table: CommandTable): string {
  const lines = ["ace runs your coding agents on this machine.", ""];
  lines.push(
    ...columns(
      shortcuts.map((item) => [item.command, item.summary]),
      2,
    ),
  );
  lines.push("");
  const groups: CommandGroup[] = ["work", "machine", "providers", "spade-market", "agent-tools"];
  const rows = groups.map((group) => {
    const words = new Set(
      table.nouns.filter((noun) => noun.group === group && !noun.hidden).map((noun) => noun.name),
    );
    for (const command of table.commands)
      if (command.group === group && !command.hidden && command.words.length === 1)
        words.add(command.words[0] ?? "");
    return [groupTitles[group], [...words].join(" · ")];
  });
  lines.push(...columns(rows, 0));
  lines.push("", "ace help COMMAND for more. ace help topics for guides.");
  return lines.join("\n");
}

/** Every command under a noun (`ace help thread`), each with its one line. */
export function nounPage(table: CommandTable, words: readonly string[]): string {
  const prefix = words.join(" ");
  const noun = table.nouns.find((item) => item.name === prefix);
  const list = table.commands.filter(
    (command) =>
      !command.hidden &&
      command.words.length > words.length &&
      command.words.slice(0, words.length).join(" ") === prefix,
  );
  const lines = [`ace ${prefix}${noun ? `: ${noun.summary}` : ""}`, ""];
  lines.push(
    ...columns(
      list.map((command) => [usageLine(command), command.summary]),
      2,
    ),
  );
  const own = table.commands.find((command) => command.words.join(" ") === prefix);
  if (own && !own.hidden) lines.unshift(...commandPage(own).split("\n"), "");
  const short = list.flatMap((command) =>
    (command.aliases ?? [])
      .filter((alias) => !alias.deprecatedSince && !alias.quiet)
      .map((alias) => `ace ${alias.words.join(" ")} is ace ${command.words.join(" ")}`),
  );
  if (short.length) lines.push("", `Shortcuts: ${short.join("; ")}.`);
  if (noun?.description) lines.push("", noun.description);
  if (prefix === "market") lines.push("", "Maintainer tools: ace help market-maintainer");
  lines.push("", `ace help ${prefix} COMMAND for one command.`);
  return lines.join("\n");
}

export function usageLine(command: CommandSpec): string {
  const args = (command.args ?? []).map((arg) => {
    const name = `${arg.name}${arg.variadic ? "…" : ""}${arg.stdin ? "|-" : ""}`;
    return arg.required ? name : `[${name}]`;
  });
  const flags = (command.flags ?? []).some((flag) => !flag.hidden) ? ["[flags]"] : [];
  return ["ace", ...command.words, ...args, ...flags].join(" ");
}

/** One command: usage, what it does, arguments, flags, examples, exit codes, other names. */
export function commandPage(command: CommandSpec): string {
  const lines = [usageLine(command), "", sentence(command.summary)];
  if (command.description) lines.push(...paragraphs(command.description));
  const args = command.args ?? [];
  if (args.length)
    lines.push(
      "",
      "Arguments",
      ...columns(
        args.map((arg) => [arg.name, arg.summary]),
        2,
      ),
    );
  const flags = (command.flags ?? []).filter((flag) => !flag.hidden);
  if (flags.length)
    lines.push(
      "",
      "Flags",
      ...columns(
        flags.map((flag) => [flagLabel(flag), flag.summary]),
        2,
      ),
    );
  const examples = command.examples ?? [];
  if (examples.length)
    lines.push(
      "",
      "Examples",
      ...columns(
        examples.map((example) => [example.command, example.summary]),
        2,
      ),
    );
  const exits = command.exits ?? [];
  if (exits.length)
    lines.push(
      "",
      "Exit codes",
      ...columns(
        exits.map((exit) => [String(exit.code), exit.when]),
        2,
      ),
    );
  const aliases = command.aliases ?? [];
  const short = aliases.filter((alias) => !alias.deprecatedSince && !alias.quiet);
  if (short.length)
    lines.push("", `Shortcut: ${short.map((alias) => `ace ${alias.words.join(" ")}`).join(", ")}`);
  const old = aliases.filter((alias) => alias.deprecatedSince);
  if (old.length)
    lines.push(`Old spelling: ${old.map((alias) => `ace ${alias.words.join(" ")}`).join(", ")}`);
  if (command.seeAlso?.length) lines.push(`See also: ${command.seeAlso.join(", ")}`);
  lines.push("", "Every command also takes --json, --quiet, --no-input and more: ace help output.");
  return lines.join("\n");
}

export function flagLabel(flag: FlagSpec): string {
  return `${flag.short ? `-${flag.short}, ` : ""}--${flag.name}${flag.value ? ` ${flag.value}` : ""}`;
}

export function globalFlagsPage(): string {
  return columns(
    globalFlags.filter((flag) => !flag.hidden).map((flag) => [flagLabel(flag), flag.summary]),
    2,
  ).join("\n");
}

export function exitCodesPage(): string {
  return columns(
    exitCodeMeanings.map((exit) => [String(exit.code), `${exit.name}: ${exit.means}`]),
    2,
  ).join("\n");
}

/** Two aligned columns; the first is padded to the widest cell, capped so text still fits. */
export function columns(rows: readonly (readonly string[])[], indent: number): string[] {
  const width = Math.min(34, Math.max(0, ...rows.map((row) => (row[0] ?? "").length)));
  const pad = " ".repeat(indent);
  return rows.map(([left = "", right = ""]) =>
    left.length > width
      ? `${pad}${left}\n${pad}${" ".repeat(width + 2)}${right}`
      : `${pad}${left.padEnd(width)}  ${right}`.trimEnd(),
  );
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Prose is wrapped; a line that starts with spaces (a table of forms) is kept as written. */
function paragraphs(text: string): string[] {
  return text.split("\n").flatMap((line) => (/^\s/.test(line) || !line ? [line] : wrap(line, 78)));
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
