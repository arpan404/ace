import type { MarketResult } from "@ace/protocol/marketplace";
import { marketError as error } from "./market-error.ts";
import { bytesText } from "./package-diff.ts";
import type { PreparedEntry } from "./review.ts";
import type { MarketStore } from "./store.ts";

export interface SpadeBotPorts {
  store: MarketStore;
  /** One version of a market bot package, fetched and checked as a review checks it. */
  fetch: (name: string, version: string) => Promise<PreparedEntry>;
}

/**
 * The version of the bot package `name` that market.acehq.dev lists now, for a Spade bot's
 * suggestion (ADR 0200 §8): its signed version manifest and `bot.json`, fetched and checked as a
 * review fetches them (the signature, the withdrawn list, ace's checks and the device's scan).
 * Only the signed market counts: a git catalog's entry is never suggested. Nothing installs.
 */
export async function spadeBot(ports: SpadeBotPorts, name: string): Promise<MarketResult> {
  const missing = error("not_found", `The market lists no bot package ${name}`);
  const source = ports.store.source("market");
  if (!source?.enabled) return missing;
  const listing = await ports.store.listing(source.id);
  const entry = listing.entries.find((item) => item.type === "spade-bot" && item.name === name);
  if (!entry?.version) return missing;
  let prepared: PreparedEntry;
  try {
    prepared = await ports.fetch(name, entry.version);
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return error("refused", `${name} can't be suggested: ${message}`.slice(0, 2000));
  }
  if (!prepared.signed || prepared.signedManifest === undefined) return missing;
  return {
    op: "spadeBot",
    signed: prepared.signedManifest,
    botJson: bytesText(prepared.checked.files),
  };
}
