// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";

import { globalFlags } from "../apps/daemon/src/cli/commands/globals.ts";
import type {
  AliasSpec,
  ArgSpec,
  CommandSpec,
  Example,
  FlagSpec,
  NounSpec,
  TopicSpec,
} from "../apps/daemon/src/cli/commands/spec.ts";
import { commandTable } from "../apps/daemon/src/cli/commands/table.ts";
import { exitCodeMeanings, topics } from "../apps/daemon/src/cli/help/topics.ts";

/**
 * Writes the TypeScript command table to `native/cli/table.json` (ADR 0221 §3). The Rust CLI
 * reads it at build time through `native/cli/crates/cli-table/build.rs`, so this file is the one
 * source of the grammar: `bun run cli:table` after changing a command, and `check:cli` fails when
 * the checked-in file is stale.
 */

const target = new URL("../native/cli/table.json", import.meta.url).pathname;

function flag(flag: FlagSpec): Record<string, unknown> {
  return {
    name: flag.name,
    ...(flag.short ? { short: flag.short } : {}),
    ...(flag.value ? { value: flag.value } : {}),
    summary: flag.summary,
    ...(flag.repeat ? { repeat: true } : {}),
    ...(flag.choices ? { choices: [...flag.choices] } : {}),
    ...(flag.ref ? { ref: flag.ref } : {}),
    ...(flag.hidden ? { hidden: true } : {}),
  };
}

function arg(arg: ArgSpec): Record<string, unknown> {
  return {
    name: arg.name,
    summary: arg.summary,
    ...(arg.required ? { required: true } : {}),
    ...(arg.variadic ? { variadic: true } : {}),
    ...(arg.stdin ? { stdin: true } : {}),
    ...(arg.ref ? { ref: arg.ref } : {}),
  };
}

function alias(alias: AliasSpec): Record<string, unknown> {
  return {
    words: [...alias.words],
    ...(alias.deprecatedSince ? { deprecatedSince: alias.deprecatedSince } : {}),
    ...(alias.insertWords ? { insertWords: [...alias.insertWords] } : {}),
    ...(alias.wordsAs ? { wordsAs: [...alias.wordsAs] } : {}),
    // Pairs, not objects: their order is part of the rule (`clean --compact` picks its command
    // by the first matching flag), and JSON objects would lose it.
    ...(alias.renameFlags ? { renameFlags: Object.entries(alias.renameFlags) } : {}),
    ...(alias.setFlags ? { setFlags: [...alias.setFlags] } : {}),
    ...(alias.byFlag ? { byFlag: Object.entries(alias.byFlag) } : {}),
    ...(alias.quiet ? { quiet: true } : {}),
  };
}

function example(example: Example): Record<string, unknown> {
  return { command: example.command, summary: example.summary };
}

function command(command: CommandSpec): Record<string, unknown> {
  return {
    id: command.id,
    words: [...command.words],
    summary: command.summary,
    ...(command.description ? { description: command.description } : {}),
    group: command.group,
    ...(command.args ? { args: command.args.map(arg) } : {}),
    ...(command.flags ? { flags: command.flags.map(flag) } : {}),
    ...(command.examples ? { examples: command.examples.map(example) } : {}),
    ...(command.aliases ? { aliases: command.aliases.map(alias) } : {}),
    ...(command.exits ? { exits: command.exits.map((exit) => ({ ...exit })) } : {}),
    ...(command.seeAlso ? { seeAlso: [...command.seeAlso] } : {}),
    ...(command.output ? { output: command.output } : {}),
    ...(command.mutates ? { mutates: true } : {}),
    ...(command.offline ? { offline: true } : {}),
    ...(command.hidden ? { hidden: true } : {}),
    ...(command.nounDefault ? { nounDefault: true } : {}),
    ...(command.personOnly ? { personOnly: command.personOnly } : {}),
    ...(command.passthrough ? { passthrough: true } : {}),
  };
}

function noun(noun: NounSpec): Record<string, unknown> {
  return {
    name: noun.name,
    summary: noun.summary,
    ...(noun.description ? { description: noun.description } : {}),
    group: noun.group,
    ...(noun.hidden ? { hidden: true } : {}),
  };
}

function topic(topic: TopicSpec): Record<string, unknown> {
  return { name: topic.name, summary: topic.summary, text: topic.text };
}

const table = commandTable();
// The one release number that lives in the table: `help --json` prints it. `cliVersion` finds
// the real one at run time; this keeps the exported table self-describing for the build.
const data = {
  format: 1,
  globalFlags: globalFlags.map(flag),
  commands: table.commands.map(command),
  nouns: table.nouns.map(noun),
  topics: topics.map(topic),
  exitCodes: exitCodeMeanings.map((exit) => ({
    code: exit.code,
    name: exit.name,
    means: exit.means,
  })),
};

const text = `${JSON.stringify(data, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const existing = (() => {
    try {
      return readFileSync(target, "utf8");
    } catch {
      return "";
    }
  })();
  if (existing !== text) {
    process.stderr.write(
      "native/cli/table.json is stale: run `bun run cli:table` and commit the change.\n",
    );
    process.exit(1);
  }
  process.stdout.write("native/cli/table.json matches the TypeScript command table.\n");
} else {
  writeFileSync(target, text);
  process.stdout.write(`Wrote ${target} (${data.commands.length} commands).\n`);
}
