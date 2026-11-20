import type { ArchiveFile } from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import type { MarketInstalled } from "@ace/protocol/marketplace";
import type { LinkedBot, SpadeBots, SpadePort } from "./install.ts";
import type { PreparedEntry } from "./review.ts";
import type { MarketStore, StoredInstall } from "./store.ts";

/*
 * The Marketplace's bot installs kept true to the bots Spade has (ADR 0200 §3.8, §6.1), at each
 * refresh. Nothing is installed, made or run here: the bots are already Spade's.
 *
 * - A linked bot that came here by a move (ADR 0187) keeps its package link and installed
 *   version in Spade. The Marketplace gets the pinned bytes by their hash, from its own store
 *   when it has them (another bot from the same package, say), else from the bot's source at
 *   that version, and keeps them only when they hash to what the bot has. Then the bot is an
 *   install here, so Update, Roll back and a withdrawal reach it.
 * - A linked bot that moved away (or is gone) is no longer this machine's: its install record
 *   goes, and the machine it went to owns it.
 * - An update Spade held for the end of a bot's turn becomes the installed version once Spade
 *   runs it, and is dropped if Spade let it go.
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

/** Spade's bots, or undefined when Spade isn't there or can't say: then nothing changes. */
async function spadeBots(ports: ArrivedPorts): Promise<SpadeBots | undefined> {
  if (!ports.spade.ready()) return undefined;
  return ports.spade.bots().catch(() => undefined);
}

/**
 * Records every linked bot Spade has that this machine's Marketplace doesn't know of, one install
 * per bot, also when the package is installed here for another bot. One whose bytes can't be had
 * now is tried again at the next refresh. True when one was recorded.
 */
async function adopt(ports: ArrivedPorts, bots: SpadeBots): Promise<boolean> {
  let changed = false;
  for (const bot of bots.linked) {
    const { package: link } = bot;
    if (sourceless(link) || ports.store.install("spade-bot", link.name, bot.id)) continue;
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

/** Forgets the install of every linked bot Spade no longer has. True when one went. */
async function forgetGone(ports: ArrivedPorts, bots: SpadeBots): Promise<boolean> {
  let changed = false;
  for (const install of ports.store.installs()) {
    if (install.type !== "spade-bot" || !install.linked || !install.target) continue;
    if (bots.ids.has(install.target)) continue;
    ports.store.removeInstallKeepingProvenance(install);
    changed = true;
  }
  if (changed) await ports.store.collect();
  return changed;
}

/**
 * Settles each update Spade held for the end of its bot's turn: once Spade runs that version the
 * record becomes it; once Spade holds nothing and still runs the version recorded, it is dropped.
 * True when a record changed.
 */
function settle(ports: Pick<ArrivedPorts, "store">, bots: SpadeBots): boolean {
  let changed = false;
  for (const install of ports.store.installs()) {
    const waiting = install.waiting;
    if (install.type !== "spade-bot" || !waiting || !install.target) continue;
    const bot = bots.linked.find((each) => each.id === install.target);
    if (!bot) continue;
    if (bot.package.hash === waiting.hash) {
      ports.store.saveInstall(waiting);
      changed = true;
    } else if (bot.package.hash === install.hash && !bot.held) {
      const { waiting: _dropped, ...running } = install;
      ports.store.saveInstall(running);
      changed = true;
    }
  }
  return changed;
}

/** Whether any install waits on an update Spade holds. */
export const holdsUpdates = (store: MarketStore) =>
  store.installs().some((install) => install.waiting !== undefined);

/** [`settle`] alone, for a read of Installed while an update waits. True when one changed. */
export async function settleHeldUpdates(ports: Pick<ArrivedPorts, "store" | "spade">) {
  if (!holdsUpdates(ports.store) || !ports.spade.ready()) return false;
  const bots = await ports.spade.bots().catch(() => undefined);
  return bots ? settle(ports, bots) : false;
}

/**
 * Brings the bot installs in line with Spade's bots: adopts arrivals, forgets bots that left, and
 * settles held updates. Spade away or unreadable changes nothing. True when anything changed.
 */
export async function reconcileBots(ports: ArrivedPorts): Promise<boolean> {
  const bots = await spadeBots(ports);
  if (!bots) return false;
  const adopted = await adopt(ports, bots);
  const forgot = await forgetGone(ports, bots);
  return settle(ports, bots) || adopted || forgot;
}
