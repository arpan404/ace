import { afterEach, beforeEach, expect, it } from "vitest";
import { commandTable } from "../commands/table.ts";
import { CliFailure } from "../output.ts";
import { parseCommandLine } from "../parse.ts";
import type { CommandContext } from "./context.ts";
import { marketHandlers } from "./market.ts";

const table = commandTable();
let token: string | undefined;
beforeEach(() => {
  token = process.env.ACE_MARKET_SIGNER_TOKEN;
  delete process.env.ACE_MARKET_SIGNER_TOKEN;
});
afterEach(() => {
  if (token !== undefined) process.env.ACE_MARKET_SIGNER_TOKEN = token;
});

function context(line: string): CommandContext {
  const parsed = parseCommandLine(table, line.split(" "));
  if (parsed.kind !== "command") throw new Error(`${line} didn't parse`);
  return {
    command: parsed.command,
    parsed,
    args: {
      words: [...parsed.words],
      flags: { ...parsed.flags },
      lists: parsed.lists,
      interactive: false,
    },
    mode: "human",
    env: {},
    table,
    config: () => {
      throw new Error("A maintainer tool never reads the daemon's config");
    },
  };
}

it.each([
  "market appeal apl_abcdefgh --answer Fine --approve",
  "market maintainer appeal apl_abcdefgh --answer Fine --approve",
  "market review",
  "market maintainer sign --key /nonexistent",
])("ace %s is the maintainer's tool, and says what it needs", async (line) => {
  const run = context(line);
  const handler = marketHandlers[run.command.id];
  const failure = await handler?.(run).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CliFailure);
  expect(failure).toMatchObject({
    message: "Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key.",
  });
});
