import type { MarketEntryDetail } from "@ace/protocol/marketplace";
import { sentence } from "./words.ts";

/* How a type is named, what keeps an entry from installing, and the action at its title row. */

const typeWords: Readonly<Record<string, string>> = {
  suit: "Suit",
  "spade-skill": "Skill",
  "spade-plugin": "Plugin",
  "spade-bot": "Bot",
  "ace-plugin": "ace plugin",
};

/** "Suit", "Skill", "Plugin", "Bot"; an unknown type's own name. */
export const typeWord = (type: string): string => typeWords[type] ?? type;

/** Why an entry can't be installed now, in one sentence; undefined when it can. */
export function installBlock(entry: MarketEntryDetail): string | undefined {
  if (!entry.summary.supported) return "Needs a newer ace.";
  const latest = entry.versions[0];
  if (latest?.withdrawn) return `Withdrawn by its publisher: ${sentence(latest.withdrawn)}`;
  return undefined;
}

/** The action at an entry's title row: what pressing it does, or that there is nothing to do. */
export function entryAction(entry: MarketEntryDetail): "install" | "update" | "installed" | "none" {
  if (installBlock(entry) && !entry.installed) return "none";
  if (!entry.installed) return "install";
  return entry.installed.update ? "update" : "installed";
}
