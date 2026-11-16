import type { MarketInstallChoices, MarketInstalled } from "@ace/protocol/marketplace";
import {
  contentHash,
  grantedNeeds,
  hashFiles,
  recipeNeeds,
  type ArchiveFile,
  type Recipe,
} from "@ace/marketplace";
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

export interface PluginPort {
  accept(review: { id: string; commit: string; hash: string }): Promise<void>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
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
  }): Promise<MadeBot>;
  allowPlugin(bot: string, plugin: string): Promise<void>;
}

export interface InstallPorts {
  store: MarketStore;
  suits: SuitPort | undefined;
  plugins: PluginPort | undefined;
  spade: SpadePort;
  now: () => number;
}

type Undo = () => Promise<void>;

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

/** Lands one entry; returns how to undo it. A recipe's own landing is `installRecipe`. */
async function land(
  ports: InstallPorts,
  entry: PreparedEntry,
  choices: MarketInstallChoices,
): Promise<{ installed: StoredInstall; undo: Undo }> {
  const { store } = ports;
  const previous = store.install(entry.type, entry.name);
  const restore: Undo = async () => {
    if (previous) store.saveInstall(previous);
    else store.removeInstall(entry.type, entry.name);
  };
  await store.pin(entry.hash, entry.type, entry.checked.files);
  switch (entry.type) {
    case "suit": {
      if (!ports.suits) throw new Error("The Suit library isn't ready");
      const suits = ports.suits;
      await suits.install(entry.name, entry.checked.files, { replace: previous !== undefined });
      const installed = record(entry, ports.now(), { target: entry.name });
      store.saveInstall(installed);
      return {
        installed,
        undo: async () => {
          if (previous)
            await suits.install(entry.name, await store.pinned(previous.hash, "suit"), {
              replace: true,
            });
          else await suits.remove(entry.name);
          await restore();
        },
      };
    }
    case "spade-skill": {
      const installed = record(entry, ports.now(), { target: entry.name });
      store.saveInstall(installed);
      return { installed, undo: restore };
    }
    case "spade-plugin": {
      if (!ports.plugins || !entry.plugin) throw new Error("Plugins aren't ready");
      const plugins = ports.plugins;
      await plugins.accept({
        id: entry.plugin.id,
        commit: entry.plugin.commit,
        hash: entry.plugin.hash,
      });
      for (const bot of choices.bots) await ports.spade.allowPlugin(bot, entry.name);
      const installed = record(entry, ports.now(), {
        target: entry.name,
        pluginCommit: entry.plugin.commit,
      });
      store.saveInstall(installed);
      return {
        installed,
        undo: async () => {
          // An update can't be taken back to the old accept; a fresh install is removed whole.
          if (!previous) await plugins.remove(entry.name);
          await restore();
        },
      };
    }
    case "spade-bot":
    case "ace-plugin":
      throw new Error(`${entry.type} entries don't land on their own`);
  }
}

/** Installs an accepted review. Throws with everything undone if any step fails. */
export async function installReview(
  ports: InstallPorts,
  review: PreparedReview,
  choices: MarketInstallChoices,
): Promise<StoredInstall> {
  if (review.type !== "spade-bot") return (await land(ports, review, choices)).installed;
  const inspection = review.checked.inspection;
  if (inspection?.type !== "spade-bot") throw new Error("The recipe didn't pass its checks");
  if (!ports.spade.ready()) throw new Error("Spade isn't running. Start Spade to make this bot.");
  const undo: Undo[] = [];
  try {
    const skills: string[] = [];
    const plugins: string[] = [];
    for (const brought of review.brings) {
      const current = ports.store.install(brought.type, brought.name);
      if (!current || current.hash !== brought.hash || current.state !== "on") {
        const landed = await land(ports, brought, { bots: [], needs: {}, startRoutines: false });
        undo.push(landed.undo);
      }
      (brought.type === "spade-skill" ? skills : plugins).push(brought.name);
    }
    for (const folder of inspection.folders) {
      if (ports.store.install("spade-skill", folder.name))
        throw new Error(`A skill called ${folder.name} is already installed`);
      const hashed = hashFiles(folder.files);
      const hash = contentHash(hashed);
      await ports.store.pin(hash, "spade-skill", folder.files);
      const installed: StoredInstall = {
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
      };
      ports.store.saveInstall(installed);
      undo.push(async () => ports.store.removeInstall("spade-skill", folder.name));
      skills.push(folder.name);
    }
    const granted = grantedNeeds(recipeNeeds(inspection.recipe), choices.needs);
    const bot = await ports.spade.createBot({
      recipe: inspection.recipe,
      fromRecipe: { source: review.source, name: review.name, version: review.version },
      grants: {
        connectors: granted
          .filter((need) => need.kind === "connector")
          .map((need) => need.key.slice("connector:".length)),
        plugins: plugins.filter((name) => granted.some((need) => need.key === `plugin:${name}`)),
        skills,
      },
      startRoutines: choices.startRoutines,
    });
    await ports.store.pin(review.hash, "spade-bot", review.checked.files);
    const installed = record(review, ports.now(), { target: bot.id });
    ports.store.saveInstall(installed);
    return installed;
  } catch (error) {
    for (const step of undo.toReversed()) await step().catch(() => {});
    throw error;
  }
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
