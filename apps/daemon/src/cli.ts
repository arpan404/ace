#!/usr/bin/env node
import { parseArgs } from "./cli/args.ts";
import { rescueCommands, rescueMain } from "./cli/rescue.ts";

const input = process.argv.slice(2);
// Triage and doctor must work when the rest of ace is broken, so they never load the
// full command table.
if (rescueCommands.has(firstWord(input))) await rescueMain(input);
else {
  const { main } = await import("./cli/main.ts");
  await main(input);
}

function firstWord(words: string[]): string {
  try {
    return parseArgs(words).words[0] ?? "";
  } catch {
    // main reports malformed arguments with its usual exit code.
    return "";
  }
}
