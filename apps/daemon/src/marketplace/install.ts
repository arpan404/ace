import type { MarketInstallChoices, MarketInstalled } from "@ace/protocol/marketplace";
import {
  contentHash,
  grantedNeeds,
  hashFiles,
  recipeNeeds,
  type ArchiveFile,
} from "@ace/marketplace";
import { type Recipe } from "@ace/protocol/marketplace";
import type { PluginReview } from "@ace/protocol/plugins";
import type { BotInspection } from "@ace/marketplace/checks";
import { Transaction } from "./journal.ts";
import type { PluginFilesInput } from "./prepare.ts";
import type { PreparedEntry, PreparedReview } from "./review.ts";
import type { MarketStore, StoredInstall } from "./store.ts";

/*
 * Landing an accepted review with the part of ace that owns its type (ADR 0168 §8): a Suit in
 * the Suit library, a skill pinned here for Spade's store, a plugin through ADR 0014's accept,
 * a recipe as a new bot made by Spade. A recipe installs what it brings first, each under its own
 * record; a step that fails undoes the steps before it, so nothing is half installed.
 */

export interface SuitPort {
  install(
    id: string,
    files: readonly ArchiveFile[],
    options: { replace: boolean },
  ): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export interface PluginAvailabilityState {
  enabled: boolean;
  providers: string[];
}

export interface PluginPort {
  accept(review: { id: string; commit: string; hash: string }): Promise<void>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  /** The version ADR 0014's manager has accepted under `name`, if any. */
  accepted(name: string): Promise<{ hash: string; commit: string; version: string } | undefined>;
  availability(name: string): Promise<PluginAvailabilityState | undefined>;
  setAvailability(name: string, availability: PluginAvailabilityState): Promise<void>;
  prepareFiles(input: PluginFilesInput): Promise<PluginReview>;
}

export interface MadeBot {
  id: string;
  leftOut: string[];
}

/** What the daemon asks of Spade, through its link (`POST /v1/agents` with `recipe`). */
export interface SpadePort {
  ready(): boolean;
  createBot(input: {
    recipe: Recipe;
    fromRecipe: { source: string; name: string; version: string };
    grants: { connectors: string[]; plugins: string[]; skills: string[] };
    startRoutines: boolean;
    /** The install's transaction: Spade makes one bot per transaction, however often asked. */
    transaction: string;
  }): Promise<MadeBot>;
  /** A bot's allowed plugins, by name. */
  pluginsOf(bot: string): Promise<string[]>;
  setPlugins(bot: string, plugins: string[]): Promise<void>;
  /** The bot made under `transaction`, if Spade has one. */
  findBot(transaction: string): Promise<string | undefined>;
  deleteBot(id: string): Promise<void>;
}

export interface InstallPorts {
  store: MarketStore;
  suits: SuitPort | undefined;
  plugins: PluginPort | undefined;
  spade: SpadePort;
  now: () => number;
}

function record(
  entry: PreparedEntry,
  now: number,
  extra: Partial<StoredInstall> = {},
): StoredInstall {
  const inspection = entry.checked.inspection;
  return {
    source: entry.source as MarketInstalled["source"],
    type: entry.type,
    name: entry.name,
    title: entry.title,
    version: entry.version,
    hash: entry.hash,
    acceptedAt: now,
    state: "on",
    files: entry.checked.hashed,
    description:
      inspection?.type === "spade-skill" ? inspection.description : entry.checked.listing.line,
    ...extra,
  };
}

/** Writes the marketplace's row for an install, noting the row it replaces. */
function saveRecord(ports: InstallPorts, tx: Transaction, installed: StoredInstall): StoredInstall {
  tx.note({
    kind: "record",
    type: installed.type,
    name: installed.name,
    previous: ports.store.install(installed.type, installed.name),
  });
  ports.store.saveInstall(installed);
  return installed;
}

/** Lands one entry under `tx`; a recipe's own landing is in `installReview`. */
async function land(
  ports: InstallPorts,
  tx: Transaction,
  entry: PreparedEntry,
  choices: MarketInstallChoices,
): Promise<StoredInstall> {
  const { store } = ports;
  const previous = store.install(entry.type, entry.name);
  await store.pin(entry.hash, entry.type, entry.checked.files);
  switch (entry.type) {
    case "suit": {
      if (!ports.suits) throw new Error("The Suit library isn't ready");
      tx.note({ kind: "suit", name: entry.name, previousHash: previous?.hash });
      await ports.suits.install(entry.name, entry.checked.files, {
        replace: previous !== undefined,
      });
      return saveRecord(ports, tx, record(entry, ports.now(), { target: entry.name }));
    }
    case "spade-skill":
      return saveRecord(ports, tx, record(entry, ports.now(), { target: entry.name }));
    case "spade-plugin": {
      const plugins = ports.plugins;
      if (!plugins || !entry.plugin) throw new Error("Plugins aren't ready");
      const accepted = await plugins.accepted(entry.name);
      if (accepted && !previous)
        throw new Error(`A plugin called ${entry.name} is already installed from elsewhere`);
      // What it replaces is written down before anything changes, so a failure puts it back.
      tx.note({
        kind: "plugin",
        name: entry.name,
        previous:
          accepted && previous
            ? { ...accepted, source: `${previous.source}:${previous.type}/${previous.name}` }
            : undefined,
        availability: accepted ? await plugins.availability(entry.name) : undefined,
      });
      await plugins.accept({
        id: entry.plugin.id,
        commit: entry.plugin.commit,
        hash: entry.plugin.hash,
      });
      for (const bot of choices.bots) {
        const before = await ports.spade.pluginsOf(bot);
        tx.note({ kind: "bot-plugins", bot, plugins: before });
        await ports.spade.setPlugins(bot, [...before, entry.name]);
      }
      return saveRecord(
        ports,
        tx,
        record(entry, ports.now(), { target: entry.name, pluginCommit: entry.plugin.commit }),
      );
    }
    case "spade-bot":
    case "ace-plugin":
      throw new Error(`${entry.type} entries don't land on their own`);
  }
}

/** A recipe's own skill folders, each a market skill brought by the recipe. */
async function landFolders(
  ports: InstallPorts,
  tx: Transaction,
  review: PreparedReview,
  folders: BotInspection["folders"],
): Promise<string[]> {
  const names: string[] = [];
  for (const folder of folders) {
    if (ports.store.install("spade-skill", folder.name))
      throw new Error(`A skill called ${folder.name} is already installed`);
    const hashed = hashFiles(folder.files);
    const hash = contentHash(hashed);
    await ports.store.pin(hash, "spade-skill", folder.files);
    saveRecord(ports, tx, {
      source: review.source as MarketInstalled["source"],
      type: "spade-skill",
      name: folder.name,
      title: folder.inspection.skillName,
      version: review.version,
      hash,
      acceptedAt: ports.now(),
      state: "on",
      files: hashed,
      description: folder.inspection.description,
      bundledBy: `spade-bot/${review.name}`,
      target: folder.name,
    });
    names.push(folder.name);
  }
  return names;
}

/**
 * Installs an accepted review as one transaction `id`: every step journaled before it is taken,
 * the bot made last, and everything undone if any step fails. Throws once undone.
 */
export async function installReview(
  ports: InstallPorts,
  review: PreparedReview,
  choices: MarketInstallChoices,
  id: string,
): Promise<StoredInstall> {
  const tx = new Transaction(ports, id);
  try {
    const installed = await installIn(ports, tx, review, choices);
    tx.commit();
    return installed;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function installIn(
  ports: InstallPorts,
  tx: Transaction,
  review: PreparedReview,
  choices: MarketInstallChoices,
): Promise<StoredInstall> {
  if (review.type !== "spade-bot") return land(ports, tx, review, choices);
  const inspection = review.checked.inspection;
  if (inspection?.type !== "spade-bot") throw new Error("The recipe didn't pass its checks");
  if (!ports.spade.ready()) throw new Error("Spade isn't running. Start Spade to make this bot.");
  const skills: string[] = [];
  const plugins: string[] = [];
  for (const brought of review.brings) {
    const current = ports.store.install(brought.type, brought.name);
    if (!current || current.hash !== brought.hash || current.state !== "on")
      await land(ports, tx, brought, { bots: [], needs: {}, startRoutines: false });
    (brought.type === "spade-skill" ? skills : plugins).push(brought.name);
  }
  skills.push(...(await landFolders(ports, tx, review, inspection.folders)));
  // The recipe's bytes are pinned before the bot exists, so a made bot always has them.
  await ports.store.pin(review.hash, "spade-bot", review.checked.files);
  const granted = grantedNeeds(recipeNeeds(inspection.recipe), choices.needs);
  const step = tx.note({ kind: "bot", transaction: tx.id });
  const bot = await ports.spade.createBot({
    recipe: inspection.recipe,
    fromRecipe: { source: review.source, name: review.name, version: review.version },
    transaction: tx.id,
    grants: {
      connectors: granted
        .filter((need) => need.kind === "connector")
        .map((need) => need.key.slice("connector:".length)),
      plugins: plugins.filter((name) => granted.some((need) => need.key === `plugin:${name}`)),
      skills,
    },
    startRoutines: choices.startRoutines,
  });
  if (step.kind === "bot") step.id = bot.id;
  tx.learned();
  return saveRecord(ports, tx, record(review, ports.now(), { target: bot.id }));
}

/** Turns an installed entry off (withdrawn, or the person's choice) without deleting it. */
export async function turnOff(ports: InstallPorts, install: StoredInstall): Promise<void> {
  switch (install.type) {
    case "suit":
      await ports.suits?.remove(install.target ?? install.name);
      return;
    case "spade-plugin":
      await ports.plugins?.setEnabled(install.name, false);
      return;
    case "spade-skill":
    case "spade-bot":
    case "ace-plugin":
      // A skill leaves Spade's list by its state; a bot made from a recipe is the person's.
      return;
  }
}

/** Turns an entry back on from its pinned bytes. */
export async function turnOn(ports: InstallPorts, install: StoredInstall): Promise<void> {
  switch (install.type) {
    case "suit":
      if (!ports.suits) throw new Error("The Suit library isn't ready");
      await ports.suits.install(
        install.target ?? install.name,
        await ports.store.pinned(install.hash, "suit"),
        { replace: true },
      );
      return;
    case "spade-plugin":
      await ports.plugins?.setEnabled(install.name, true);
      return;
    case "spade-skill":
    case "spade-bot":
    case "ace-plugin":
      await ports.store.pinned(install.hash, install.type);
      return;
  }
}

/** Removes an install through its owner; a bot made from a recipe stays, only the record goes. */
export async function removeInstall(ports: InstallPorts, install: StoredInstall): Promise<void> {
  if (install.type === "suit" && install.state === "on")
    await ports.suits?.remove(install.target ?? install.name);
  if (install.type === "spade-plugin") await ports.plugins?.remove(install.name);
  ports.store.removeInstall(install.type, install.name);
  await ports.store.collect();
}
