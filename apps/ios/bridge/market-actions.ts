import type { MarketEntrySummary, MarketInstalled } from "@ace/protocol/marketplace";
import { entryRow, installedRow, type MarketWords } from "./market-rows.ts";

/*
 * What a browse row's button and long press do, decided here so Swift only draws it: Get,
 * Update, Installed, why it can't install, or nothing while what's installed is unknown. Each
 * installed copy is named, a bot package's by its bot, so Update and Remove act on the copy the
 * person chose. Pure.
 */

/** What browse rows are written from besides the daemon's result. */
export interface BrowseWords extends MarketWords {
  /**
   * What the machine has installed, as last read; undefined when it couldn't be read, and then
   * no row offers Get, since it may already be installed.
   */
  readonly installed?: readonly MarketInstalled[] | undefined;
  /** A bot's name by its id, once Spade's list has said. */
  readonly botName?: ((id: string) => string | undefined) | undefined;
}

/** One installed copy a row acts on, with the words its menu item and Remove's question use. */
function copyOf(item: MarketInstalled, words: BrowseWords) {
  const install = installedRow(item);
  const bot = install.bot === null ? null : (words.botName?.(install.bot) ?? install.bot);
  return {
    install,
    /** The menu item choosing it: the bot's name, or the entry's title. */
    label: bot ?? install.title,
    question:
      bot === null
        ? `Remove ${install.title}?`
        : `Remove ${bot}'s skills and plugins? The bot stays yours.`,
    update: install.update !== null,
  };
}

/** A listing's button: what it says and what pressing it, or a long press, acts on. */
export function rowAction(summary: MarketEntrySummary, words: BrowseWords) {
  if (!words.installed) return { kind: "unknown", word: null, reason: null, copies: [] };
  const copies = words.installed
    .filter(
      (item) =>
        item.source === summary.source && item.type === summary.type && item.name === summary.name,
    )
    .map((item) => copyOf(item, words));
  if (copies.some((copy) => copy.update))
    return { kind: "update", word: "Update", reason: null, copies };
  if (copies.length) return { kind: "installed", word: "Installed", reason: null, copies };
  if (!summary.supported)
    return { kind: "blocked", word: null, reason: "Needs a newer ace", copies: [] };
  return { kind: "get", word: "Get", reason: null, copies: [] };
}

/** A browse row: the listing's words and its action. */
export const listingRow = (words: BrowseWords) => (summary: MarketEntrySummary) => ({
  ...entryRow(summary),
  action: rowAction(summary, words),
});
