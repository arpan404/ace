import type { ArchiveFile } from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import type { MarketInstalled } from "@ace/protocol/marketplace";
import type { LinkedBot, SpadePort } from "./install.ts";
import type { PreparedEntry } from "./review.ts";
import type { MarketStore, StoredInstall } from "./store.ts";

/*
 * A linked bot that came here by a move (ADR 0187) keeps its package link and installed version
 * in Spade (ADR 0200 §3.8). This machine's Marketplace learns of it at a refresh: it gets the
 * pinned bytes by their hash, from its own store when it has them, else from the bot's source at
 * that version, and keeps them only when they hash to what the bot has. Then the bot is an
 * install here, so Update, Roll back and a withdrawal reach it as they reach one installed here.
 * Nothing is installed, made or run: the bot is already Spade's.
 */

export interface ArrivedPorts {
  store: MarketStore;
  spade: SpadePort;
  now: () => number;
  /** That version from its source, checked as a review checks it; throws when it can't be had. */
  fetch: (source: string, name: string, version: string) => Promise<PreparedEntry>;
}

interface Bytes {
  files: ArchiveFile[];
  fetched: PreparedEntry | undefined;
}

/** The bytes of `hash`: pinned here, or fetched at `version` and pinned when they match. */
async function bytesOf(
  ports: ArrivedPorts,
  link: { source: string; name: string },
  version: string,
  hash: string,
): Promise<Bytes | undefined> {
  try {
    return { files: await ports.store.pinned(hash, "spade-bot"), fetched: undefined };
  } catch {
    // Not here: the source has it.
  }
  const fetched = await ports.fetch(link.source, link.name, version).catch(() => undefined);
  if (!fetched || fetched.hash !== hash) return undefined;
  await ports.store.pin(hash, "spade-bot", fetched.checked.files);
  return { files: fetched.checked.files, fetched };
}

/** The install record of a bot that arrived with `bytes`, or none when they don't pass. */
function recordOf(bot: LinkedBot, bytes: Bytes, now: number): StoredInstall | undefined {
  const { package: link } = bot;
  const checked = checkFiles("spade-bot", link.name, bytes.files);
  if (checked.problems.length > 0 || checked.hash !== link.hash) return undefined;
  const { fetched } = bytes;
  return {
    source: link.source as MarketInstalled["source"],
    type: "spade-bot",
    name: link.name,
    title: fetched?.title ?? checked.listing.title,
    version: link.version,
    hash: link.hash,
    acceptedAt: now,
    state: "on",
    files: checked.hashed,
    description: checked.listing.line,
    target: bot.id,
    linked: true,
    ...(fetched ? { signed: fetched.signed } : {}),
    ...(fetched?.publisher ? { publisher: fetched.publisher.id } : {}),
  };
}

/**
 * Linked to a package no source holds: one Spade ships itself (a template, `spade/<id>`) or a
 * local package (`ace bot dev`, or a version 3 package installed without the market's
 * signature). Those aren't the Marketplace's installs, here or anywhere.
 */
export function sourceless(link: { source: string }): boolean {
  return link.source === "spade" || link.source === "local";
}

/**
 * Records every linked bot Spade has that this machine's Marketplace doesn't know of; true when
 * one was recorded. A package already installed here for another bot is left as it is. One whose
 * bytes can't be had now is tried again at the next refresh.
 */
export async function adoptArrivedBots(ports: ArrivedPorts): Promise<boolean> {
  if (!ports.spade.ready()) return false;
  const linked = await ports.spade.linkedBots().catch(() => []);
  let changed = false;
  for (const bot of linked) {
    const { package: link } = bot;
    if (sourceless(link) || ports.store.install("spade-bot", link.name)) continue;
    const bytes = await bytesOf(ports, link, link.version, link.hash);
    const record = bytes && recordOf(bot, bytes, ports.now());
    if (!record) continue;
    // The version it had before, kept so a rollback needs no network, when it can be had.
    const previous = bot.previous;
    const before = previous && (await bytesOf(ports, link, previous.version, previous.hash));
    ports.store.saveInstall(before && previous ? { ...record, previous } : record);
    changed = true;
  }
  return changed;
}
