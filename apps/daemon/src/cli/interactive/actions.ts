import type { CommandTable } from "../commands/table.ts";
import type { Terminal } from "../tui/terminal.ts";
import type { Place } from "./effects.ts";

/**
 * The things the interactive views hand the terminal over for (ADR 0178 §9): the existing
 * commands run in place (doctor, triage, Spade, Store, settings, projects), so the views use
 * the same data paths and output as the scripted commands.
 */

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
