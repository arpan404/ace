import type { MarketEntryDetail, MarketInstalled } from "@ace/protocol/marketplace";
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
  return offeredUpdate(entry.installed) ? "update" : "installed";
}

/**
 * The update an install offers: none while one the person already accepted waits for its bot's
 * turn to end (ADR 0200), so the count, the list and the entry page never offer it twice.
 */
export function offeredUpdate(item: Pick<MarketInstalled, "update" | "held">): string | undefined {
  return item.update && item.update !== item.held?.version ? item.update : undefined;
}
