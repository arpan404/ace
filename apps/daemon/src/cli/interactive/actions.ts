import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandTable } from "../commands/table.ts";
import type { Terminal } from "../tui/terminal.ts";
import type { Place } from "./effects.ts";

/**
 * The things the interactive views hand the terminal over for (ADR 0178 §9): $EDITOR, and
 * the existing commands run in place (doctor, triage, Spade, market, settings, projects), so
 * the views use the same data paths and output as the scripted commands.
 */

/** Opens $VISUAL or $EDITOR on `text`; returns what the person saved, or `text` unchanged. */
export function editText(terminal: Terminal, text: string, env: NodeJS.ProcessEnv): string {
  const editor =
    env.VISUAL?.trim() || env.EDITOR?.trim() || (process.platform === "win32" ? "notepad" : "vi");
  const folder = mkdtempSync(join(tmpdir(), "ace-prompt-"));
  const file = join(folder, "prompt.md");
  writeFileSync(file, text, { mode: 0o600 });
  terminal.suspend();
  try {
    // The editor command may carry its own flags ("code --wait"): the shell splits it.
    const result = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (result.status !== 0) return text;
    return readFileSync(file, "utf8").replace(/\n$/, "");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    terminal.resume();
  }
}

/** The table's command for each place, first one this build has. */
const placeCommands: Record<Place, readonly string[]> = {
  projects: ["project.list"],
  spade: ["spade.status", "spade.list", "spade.bots"],
  market: ["market.search", "market.browse", "market.installed"],
  settings: ["config.list", "config.get"],
  help: ["help"],
};

/** The words that run `place`'s command, or undefined when this build has none. */
export function placeWords(table: CommandTable, place: Place): string[] | undefined {
  for (const id of placeCommands[place]) {
    const command = table.byId.get(id);
    if (command) return [...command.words];
  }
  return undefined;
}

/**
 * Runs one ace command line in place, with the terminal handed back, its output landing in the
 * scrollback above the view. Its exit code doesn't become the home's.
 */
export async function runInPlace(terminal: Terminal, words: readonly string[]): Promise<void> {
  const exitCode = process.exitCode;
  terminal.suspend();
  try {
    const { main } = await import("../main.ts");
    await main(words);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    process.exitCode = exitCode;
    terminal.resume();
  }
}
