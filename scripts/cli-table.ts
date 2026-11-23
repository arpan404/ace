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

function flag(spec: FlagSpec): Record<string, unknown> {
  return {
    name: spec.name,
    ...(spec.short ? { short: spec.short } : {}),
    ...(spec.value ? { value: spec.value } : {}),
    summary: spec.summary,
    ...(spec.repeat ? { repeat: true } : {}),
    ...(spec.choices ? { choices: [...spec.choices] } : {}),
    ...(spec.ref ? { ref: spec.ref } : {}),
    ...(spec.hidden ? { hidden: true } : {}),
  };
}

function arg(spec: ArgSpec): Record<string, unknown> {
  return {
    name: spec.name,
    summary: spec.summary,
    ...(spec.required ? { required: true } : {}),
    ...(spec.variadic ? { variadic: true } : {}),
    ...(spec.stdin ? { stdin: true } : {}),
    ...(spec.ref ? { ref: spec.ref } : {}),
  };
}

function alias(spec: AliasSpec): Record<string, unknown> {
  return {
    words: [...spec.words],
    ...(spec.deprecatedSince ? { deprecatedSince: spec.deprecatedSince } : {}),
    ...(spec.insertWords ? { insertWords: [...spec.insertWords] } : {}),
    ...(spec.wordsAs ? { wordsAs: [...spec.wordsAs] } : {}),
    // Pairs, not objects: their order is part of the rule (`clean --compact` picks its command
    // by the first matching flag), and JSON objects would lose it.
    ...(spec.renameFlags ? { renameFlags: Object.entries(spec.renameFlags) } : {}),
    ...(spec.setFlags ? { setFlags: [...spec.setFlags] } : {}),
    ...(spec.byFlag ? { byFlag: Object.entries(spec.byFlag) } : {}),
    ...(spec.quiet ? { quiet: true } : {}),
  };
}

function example(spec: Example): Record<string, unknown> {
  return { command: spec.command, summary: spec.summary };
}

function command(spec: CommandSpec): Record<string, unknown> {
  return {
    id: spec.id,
    words: [...spec.words],
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    group: spec.group,
    ...(spec.args ? { args: spec.args.map(arg) } : {}),
    ...(spec.flags ? { flags: spec.flags.map(flag) } : {}),
    ...(spec.examples ? { examples: spec.examples.map(example) } : {}),
    ...(spec.aliases ? { aliases: spec.aliases.map(alias) } : {}),
    ...(spec.exits ? { exits: spec.exits.map((exit) => ({ ...exit })) } : {}),
    ...(spec.seeAlso ? { seeAlso: [...spec.seeAlso] } : {}),
    ...(spec.output ? { output: spec.output } : {}),
    ...(spec.mutates ? { mutates: true } : {}),
    ...(spec.offline ? { offline: true } : {}),
    ...(spec.hidden ? { hidden: true } : {}),
    ...(spec.nounDefault ? { nounDefault: true } : {}),
    ...(spec.personOnly ? { personOnly: spec.personOnly } : {}),
    ...(spec.passthrough ? { passthrough: true } : {}),
  };
}

function noun(spec: NounSpec): Record<string, unknown> {
  return {
    name: spec.name,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    group: spec.group,
    ...(spec.hidden ? { hidden: true } : {}),
  };
}

function topic(spec: TopicSpec): Record<string, unknown> {
  return { name: spec.name, summary: spec.summary, text: spec.text };
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
