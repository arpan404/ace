import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commandTable } from "./commands/table.ts";
import { parseCommandLine } from "./parse.ts";

/*
 * The make-a-bot skill teaches an agent the developer kit's commands from prose. Every `ace …`
 * line it shows must be one the CLI takes as written, so an agent following it never meets a
 * usage error.
 */

const skill = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../packages/plugins/builtin-skills/skills/make-a-bot/SKILL.md",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** Each `ace …` command in backticks, with its placeholders filled as an agent would. */
const lines = [...skill.matchAll(/`(ace [^`]+)`/g)]
  .map((match) => match[1] ?? "")
  .map((line) =>
    line
      .replace(/\[([^\]]+)\]/g, "$1")
      .replaceAll("\\|", "|")
      .replace(/--template blank\|watcher\|club-member/, "--template watcher")
      .replace(/\bNAME\b/, "Fare-watcher")
      .replace(/\bPATH\b/, ".")
      .replace(/\bDIR\b/, "./fare-watcher")
      .replace(/\bV\b/, "1.0.0")
      .replace(/\bID\b/, "drf_abcdefgh"),
  );

test("the skill shows the developer kit's commands", () => {
  const verbs = new Set(lines.map((line) => line.split(" ").slice(0, 3).join(" ")));
  for (const verb of ["init", "check", "test", "dev", "publish"])
    expect(verbs, `ace bot ${verb}`).toContain(`ace bot ${verb}`);
});

/** The words a shell would pass: quoted ones kept whole. */
const words = (line: string) =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");

test.each(lines)("%s is a command line the CLI takes", (line) => {
  const parsed = parseCommandLine(commandTable(), words(line).slice(1));
  expect(parsed.kind === "usage" ? parsed.message : "ok").toBe("ok");
});
