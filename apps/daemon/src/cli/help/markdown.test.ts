import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { commandTable } from "../commands/table.ts";
import { cliMarkdown } from "./markdown.ts";

test("the CLI reference in docs matches the command table (bun apps/daemon/scripts/cli-doc.ts)", () => {
  const path = fileURLToPath(new URL("../../../../../docs/daemon/cli.md", import.meta.url));
  expect(readFileSync(path, "utf8")).toBe(cliMarkdown(commandTable()));
});

test("the reference covers every visible command and none of the hidden ones", () => {
  const page = cliMarkdown(commandTable());
  for (const command of commandTable().commands.filter((item) => item.words.length))
    expect(page.includes(`### \`ace ${command.words.join(" ")}`), command.id).toBe(!command.hidden);
});
