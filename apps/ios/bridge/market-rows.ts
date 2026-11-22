import type { MarketEntrySummary, MarketInstalled } from "@ace/protocol/marketplace";
import { typeWord } from "@ace/ui-core/market";

/*
 * The marketplace rows every area of the phone's market draws (`market-home.ts`,
 * `market-review.ts`, `market-installed.ts`): a listing and an install, with their words
 * written. Pure.
 */

/** What an area's answer is built from besides the daemon's result. */
export interface MarketWords {
  /** Now, for "Listings from 3:04 PM". */
  readonly now: number;
}

/** The short words a link names a type by, as the web's `?market=` does. */
const linkWords: Readonly<Record<string, string>> = {
  suit: "suit",
  "spade-bot": "bot",
  "spade-skill": "skill",
  "spade-plugin": "plugin",
};

/** `ace://market?at=skill/triage-mail`, with `@git:…` for a git catalog's entry. */
function linkOf(summary: MarketEntrySummary): string {
  const at = `${linkWords[summary.type] ?? summary.type}/${summary.name}`;
  return `ace://market?at=${summary.source === "market" ? at : `${at}@${summary.source}`}`;
}

/** A listing as a row: its key, its words, and what its trailing button starts as. */
export function entryRow(summary: MarketEntrySummary) {
  return {
    id: `${summary.source}/${summary.type}/${summary.name}`,
    source: summary.source,
    type: summary.type,
    name: summary.name,
    title: summary.title,
    line: summary.line,
    typeWord: typeWord(summary.type),
    publisher: summary.publisher?.name ?? null,
    verified: summary.verified === true,
    byAce: summary.byAce,
    reviewed: summary.reviewed,
    supported: summary.supported,
    version: summary.version ?? null,
    picture: summary.previews?.[0] ?? null,
    /** A type this build can't install reads so, and has no Get (spec item 8). */
    block: summary.supported ? null : "Needs a newer ace",
    /** What Share link sends. */
    link: linkOf(summary),
  };
}

/** An install as a row: its type, version and state in words. */
export function installedRow(item: MarketInstalled) {
  const waitsForBots = item.type === "spade-skill" && item.botsApproved === false;
  return {
    id:
      item.target && item.type === "spade-bot"
        ? `${item.type}/${item.name}#${item.target}`
        : `${item.type}/${item.name}`,
    source: item.source,
    type: item.type,
    name: item.name,
    title: item.title,
    typeWord: typeWord(item.type),
    version: item.version,
    hash: item.hash,
    bot: item.type === "spade-bot" ? (item.target ?? null) : null,
    update: item.update ?? null,
    state: item.state,
    waitsForBots,
    status: installedStatus(item, waitsForBots),
  };
}

function installedStatus(item: MarketInstalled, waitsForBots: boolean): string {
  if (item.state === "withdrawn" || item.state === "blocked")
    return item.reason ? `Off: ${item.reason}` : "Off";
  if (item.state !== "on") return "Off";
  if (waitsForBots) return "Installed · Turn on for your bots";
  if (item.update) return `Update to ${item.update}`;
  return `Version ${item.version}`;
}

/** "1 update", "2 updates"; nothing when there are none. */
export const updatesText = (updates: number): string | null =>
  updates ? `${updates} ${updates === 1 ? "update" : "updates"}` : null;
