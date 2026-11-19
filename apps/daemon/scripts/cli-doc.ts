import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commandTable } from "../src/cli/commands/table.ts";
import { cliMarkdown } from "../src/cli/help/markdown.ts";

/** Writes docs/daemon/cli.md from the CLI's command table (ADR 0178 §5). */
const path = fileURLToPath(new URL("../../../docs/daemon/cli.md", import.meta.url));
writeFileSync(path, cliMarkdown(commandTable()));
process.stdout.write(`Wrote ${path}\n`);
