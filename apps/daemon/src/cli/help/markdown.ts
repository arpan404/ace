import type { CommandGroup, CommandSpec } from "../commands/spec.ts";
import type { CommandTable } from "../commands/table.ts";
import { exitCodeMeanings, topics } from "./topics.ts";
import { flagLabel, groupTitles, usageLine } from "./pages.ts";
import { globalFlags } from "../commands/globals.ts";

/**
 * `docs/daemon/cli.md`, from the command table (ADR 0178 §5). Pure, so a test can check the
 * committed page against the table and help can never drift from what runs.
 */
export function cliMarkdown(table: CommandTable): string {
  const out: string[] = [
    "# The ace CLI",
    "",
    "<!-- Generated from apps/daemon/src/cli/commands by `bun apps/daemon/scripts/cli-doc.ts`. Don't edit by hand. -->",
    "",
    "Every command is `ace <noun> <verb> [ARGUMENTS] [FLAGS]` ([ADR 0178](../adr/0178-one-cli-grammar-interactive-home-and-market.md)).",
    "`ace help COMMAND` prints the same page in a terminal, and `ace help --json` prints all of it as JSON.",
    "",
    "## Global flags",
    "",
    "| Flag | Means |",
    "| --- | --- |",
    ...globalFlags
      .filter((flag) => !flag.hidden)
      .map((flag) => `| \`${flagLabel(flag)}\` | ${cell(flag.summary)} |`),
    "",
    "## Exit codes",
    "",
    "| Code | Name | Means |",
    "| --- | --- | --- |",
    ...exitCodeMeanings.map((exit) => `| ${exit.code} | \`${exit.name}\` | ${exit.means} |`),
    "",
  ];
  const groups: CommandGroup[] = [
    "basics",
    "work",
    "machine",
    "providers",
    "spade-market",
    "agent-tools",
  ];
  for (const group of groups) {
    const list = table.commands.filter((command) => command.group === group && !command.hidden);
    if (!list.length) continue;
    out.push(`## ${groupTitles[group]}`, "");
    for (const command of list) out.push(...section(command));
  }
  const old = table.commands.flatMap((command) =>
    (command.aliases ?? [])
      .filter((alias) => alias.deprecatedSince)
      .map(
        (alias) =>
          `| \`ace ${alias.words.join(" ")}\` | \`ace ${command.words.join(" ")}\` | ${alias.deprecatedSince} |`,
      ),
  );
  out.push(
    "## Old spellings",
    "",
    "Each prints a notice on a terminal for two releases after the one it was replaced in, is a usage error naming the new command in the third, and is then removed.",
    "",
    "| Old | New | Replaced in |",
    "| --- | --- | --- |",
    ...old,
    "",
    "## Topics",
    "",
  );
  for (const topic of topics.filter((item) => item.text))
    out.push(`### ${topic.summary}`, "", "```", topic.text, "```", "");
  return `${out.join("\n").trimEnd()}\n`;
}

function section(command: CommandSpec): string[] {
  const lines = [`### \`${usageLine(command)}\``, "", sentence(command.summary)];
  if (command.description) lines.push("", command.description);
  const args = command.args ?? [];
  if (args.length) lines.push("", ...args.map((arg) => `- \`${arg.name}\`: ${arg.summary}`));
  const flags = (command.flags ?? []).filter((flag) => !flag.hidden);
  if (flags.length)
    lines.push("", ...flags.map((flag) => `- \`${flagLabel(flag)}\`: ${flag.summary}`));
  const short = (command.aliases ?? []).filter((alias) => !alias.deprecatedSince && !alias.quiet);
  if (short.length)
    lines.push(
      "",
      `Shortcut: ${short.map((alias) => `\`ace ${alias.words.join(" ")}\``).join(", ")}.`,
    );
  for (const example of command.examples ?? [])
    lines.push("", `    ${example.command}`, `    # ${example.summary}`);
  lines.push("");
  return lines;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
