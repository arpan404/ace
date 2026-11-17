import type { CliCommand, CliCommandTree } from "@ace/protocol/cli-output";
import { globalFlags } from "../commands/globals.ts";
import type { CommandSpec, FlagSpec } from "../commands/spec.ts";
import type { CommandTable } from "../commands/table.ts";
import { usageFailure } from "../output.ts";
import { nearest } from "../suggest.ts";
import { commandPage, exitCodesPage, globalFlagsPage, nounPage, overview } from "./pages.ts";
import { exitCodeMeanings, topics } from "./topics.ts";

/** What `ace help WORDS…` answers: a page of text, and the command it is about, if any. */
export interface HelpAnswer {
  readonly text: string;
  readonly command?: CommandSpec;
}

/** Pure. Unknown words are a usage error with the nearest command or topic. */
export function helpFor(table: CommandTable, words: readonly string[]): HelpAnswer {
  if (words.length === 0) return { text: overview(table) };
  const key = words.join(" ");
  if (key === "topics")
    return {
      text: topics.map((topic) => `  ${topic.name.padEnd(18)} ${topic.summary}`).join("\n"),
    };
  if (key === "flags") return { text: globalFlagsPage() };
  const topic = topics.find((item) => item.name === key);
  if (topic) return { text: topic.name === "exit-codes" ? exitCodesPage() : topic.text };
  const route = table.routes.get(key);
  // A noun, or a prefix like `market maintainer`, lists what's under it.
  if (table.next.has(key)) return { text: nounPage(table, words) };
  if (route) return { text: commandPage(route.command), command: route.command };
  const candidates = [...table.routes.keys(), ...topics.map((item) => item.name)].filter(
    (candidate) => candidate.split(" ").length === words.length,
  );
  const suggestion = nearest(key, candidates);
  throw usageFailure(`There's no help for ${key}.`, {
    code: "unknown_command",
    hint: suggestion ? `Did you mean ace help ${suggestion}?` : "See every command with ace help.",
  });
}

function flagJson(flag: FlagSpec) {
  return {
    name: flag.name,
    ...(flag.short ? { short: flag.short } : {}),
    ...(flag.value ? { value: flag.value } : {}),
    summary: flag.summary,
    repeat: flag.repeat ?? false,
    ...(flag.choices ? { choices: [...flag.choices] } : {}),
  };
}

export function commandJson(command: CommandSpec): CliCommand {
  return {
    id: command.id,
    words: [...command.words],
    summary: command.summary,
    ...(command.description ? { description: command.description } : {}),
    group: command.group,
    arguments: (command.args ?? []).map((arg) => ({
      name: arg.name,
      summary: arg.summary,
      required: arg.required ?? false,
      variadic: arg.variadic ?? false,
      stdin: arg.stdin ?? false,
    })),
    flags: (command.flags ?? []).filter((flag) => !flag.hidden).map(flagJson),
    examples: (command.examples ?? []).map(({ command: line, summary }) => ({
      command: line,
      summary,
    })),
    aliases: (command.aliases ?? [])
      .filter((alias) => !alias.quiet)
      .map((alias) =>
        alias.deprecatedSince
          ? { words: [...alias.words], deprecatedSince: alias.deprecatedSince }
          : { words: [...alias.words] },
      ),
    ...(command.output ? { output: command.output } : {}),
    mutates: command.mutates ?? false,
    offline: command.offline ?? false,
  };
}

/** `ace help --json`: everything an agent needs to call ace without reading prose. */
export function commandTree(table: CommandTable, version: string): CliCommandTree {
  return {
    version,
    globalFlags: globalFlags.filter((flag) => !flag.hidden).map(flagJson),
    commands: table.commands.filter((command) => !command.hidden).map(commandJson),
    topics: topics.map((topic) => ({ name: topic.name, summary: topic.summary })),
    exitCodes: exitCodeMeanings.map(({ code, name, means }) => ({ code, name, means })),
  };
}
