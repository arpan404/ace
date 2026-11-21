import type { MarketInstallChoices, MarketInstalled } from "@ace/protocol/marketplace";
import {
  contentHash,
  grantedEffects,
  grantedNeeds,
  hashFiles,
  recipeNeeds,
  type ArchiveFile,
} from "@ace/marketplace";
import { type PackageLinkId, type PackagePlan, type Recipe } from "@ace/protocol/marketplace";
import type { PluginReview } from "@ace/protocol/plugins";
import { panelPageTexts, type BotInspection } from "@ace/marketplace/checks";
import { Transaction } from "./journal.ts";
import { bytesJson, bytesText, codeBytes, contractTexts } from "./package-diff.ts";
import type { PluginFilesInput } from "./prepare.ts";
import type { PreparedEntry, PreparedReview } from "./review.ts";
import { approvedForBots, type MarketStore, type StoredInstall } from "./store.ts";

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
  /** The full path of one of the person's Suits' folder, to publish it from. */
  folder(id: string): string;
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

/**
 * A version 3 package's link (ADR 0200 §3.9): `bot.json` as published and, for a market package,
 * the market's signed manifest with `bot.json`'s exact text, which is all Spade believes its
 * identity from. Without one (a git catalog's entry) Spade links it as a local package.
 */
export interface PackageInput {
  /** `bot.json` as the signed bytes have it: Spade reads it with its own reader. */
  manifest: unknown;
  signed?:
    | {
        package: PackageLinkId;
        signedManifest: unknown;
        botJson: string;
        /** Its contracts' schema files, by path, exactly as signed (ADR 0200 §7). */
        contractFiles?: Record<string, string> | undefined;
      }
    | undefined;
  /** Its panels' pages (ADR 0200 §5.2), by path: Spade keeps them by hash with the bot. */
  pages?: Record<string, string> | undefined;
  /**
   * Its WebAssembly components (ADR 0203 §5), by path, in base64: Spade checks them, holds a
   * market version's to the bytes its signed manifest lists, and pins them by sha256.
   */
  code?: Record<string, string> | undefined;
}

/** What the daemon asks of Spade, through its link (`POST /v1/agents` with `recipe`). */
export interface SpadePort {
  ready(): boolean;
  /** The running Spade's version, once it has answered; a review checks `requires.spade` by it. */
  version(): string | undefined;
  createBot(input: {
    recipe: Recipe;
    fromRecipe: { source: string; name: string; version: string };
    grants: { connectors: string[]; plugins: string[]; skills: string[] };
    startRoutines: boolean;
    /** The install's transaction: Spade makes one bot per transaction, however often asked. */
    transaction: string;
    /** For a version 3 package: the bot stays linked, with the effect switches the person set. */
    linked?: PackageInput & { switches: Record<string, boolean> };
  }): Promise<MadeBot>;
  /** What moving a linked bot to `manifest` would do: Spade's plan, for the review. */
  planUpdate(bot: string, manifest: unknown): Promise<PackagePlan>;
  /**
   * Moves a linked bot to another version, one step keyed by `transaction`. While the bot works
   * Spade holds the step for the end of its turn and says `held`.
   */
  updateBot(bot: string, input: PackageInput & { transaction: string }): Promise<{ held: boolean }>;
  /** Its version was withdrawn: the bot is paused with the reason, nothing deleted. */
  withdrawBot(bot: string, reason: string): Promise<void>;
  /** The person resumes a bot its version's withdrawal paused. */
  resumeBot(bot: string): Promise<void>;
  /** A bot's allowed plugins, by name. */
  pluginsOf(bot: string): Promise<string[]>;
  setPlugins(bot: string, plugins: string[]): Promise<void>;
  /** The bot made under `transaction`, if Spade has one. */
  findBot(transaction: string): Promise<string | undefined>;
  /**
   * Every bot Spade has, and of each linked one the version it runs and any update it holds:
   * what a move brings (ADR 0187), and what one took away. Throws when Spade can't say.
   */
  bots(): Promise<SpadeBots>;
  deleteBot(id: string): Promise<void>;
}

/** A bot Spade says is linked to a package, and the version it has. */
export interface LinkedBot {
  id: string;
  package: { source: string; name: string; version: string; hash: string };
  previous?: { version: string; hash: string } | undefined;
  /** An update Spade holds until the bot's turn ends. */
  held?: { version: string } | undefined;
}

/** Spade's bots as the Marketplace reads them: every id, and the linked ones' links. */
export interface SpadeBots {
  ids: ReadonlySet<string>;
  linked: LinkedBot[];
}

export interface InstallPorts {
  store: MarketStore;
  suits: SuitPort | undefined;
  plugins: PluginPort | undefined;
  spade: SpadePort;
  now: () => number;
  /**
   * Throws when the install may not go on (the marketplace turned off); checked before each
   * step, so a throw undoes the steps before it. Undoing never asks it.
   */
  gate?: () => Promise<void>;
}

const step = (ports: InstallPorts) => ports.gate?.() ?? Promise.resolve();

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
    signed: entry.signed,
    ...(entry.publisher ? { publisher: entry.publisher.id } : {}),
    ...extra,
  };
}

/**
 * Who an install is by (ADR 0178 §12.8): the person (their credential, a fresh sign-in, or their
 * answer to an agent's request), or a caller without their standing on the content-only
 * exemption. A Spade skill the person installs is on for their bots; one anyone else installs
 * waits for the person to turn it on.
 */
export type Installer = "person" | "without-person";

/**
 * A skill's approval after this install: the person's install approves its hash; anyone else's
 * leaves it waiting, except that the very bytes installed again keep the approval they had.
 */
function botsApproval(
  entry: PreparedEntry,
  by: Installer,
  previous: StoredInstall | undefined,
): Partial<StoredInstall> {
  if (entry.type !== "spade-skill") return {};
  if (by === "person") return { approvedHash: entry.hash };
  if (previous?.hash === entry.hash)
    return previous.approvedHash === undefined ? {} : { approvedHash: previous.approvedHash };
  return { approvedHash: null };
}

/** Writes the marketplace's row for an install, noting the row it replaces. */
function saveRecord(ports: InstallPorts, tx: Transaction, installed: StoredInstall): StoredInstall {
  // A bot package's row is its bot's: installing it again makes another bot, another row.
  const bot = installed.type === "spade-bot" ? installed.target : undefined;
  tx.note({
    kind: "record",
    type: installed.type,
    name: installed.name,
    ...(bot ? { bot } : {}),
    previous: ports.store.install(installed.type, installed.name, bot),
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
  by: Installer,
): Promise<StoredInstall> {
  const { store } = ports;
  const previous = store.install(entry.type, entry.name);
  await step(ports);
  await store.pin(entry.hash, entry.type, entry.checked.files);
  switch (entry.type) {
    case "suit": {
      if (!ports.suits) throw new Error("The Suit library isn't ready");
      tx.note({ kind: "suit", name: entry.name, previousHash: previous?.hash });
      await step(ports);
      await ports.suits.install(entry.name, entry.checked.files, {
        replace: previous !== undefined,
      });
      await step(ports);
      return saveRecord(ports, tx, record(entry, ports.now(), { target: entry.name }));
    }
    case "spade-skill":
      await step(ports);
      return saveRecord(
        ports,
        tx,
        record(entry, ports.now(), { target: entry.name, ...botsApproval(entry, by, previous) }),
      );
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
      await step(ports);
      await plugins.accept({
        id: entry.plugin.id,
        commit: entry.plugin.commit,
        hash: entry.plugin.hash,
      });
      for (const bot of choices.bots) {
        const before = await ports.spade.pluginsOf(bot);
        tx.note({ kind: "bot-plugins", bot, plugins: before });
        await step(ports);
        await ports.spade.setPlugins(bot, [...before, entry.name]);
      }
      await step(ports);
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
    const present = ports.store.install("spade-skill", folder.name);
    // An update of a linked bot replaces the skills its own earlier version brought.
    if (present && present.bundledBy !== `spade-bot/${review.name}`)
      throw new Error(`A skill called ${folder.name} is already installed`);
    const hashed = hashFiles(folder.files);
    const hash = contentHash(hashed);
    await step(ports);
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
      signed: review.signed,
      ...(review.publisher ? { publisher: review.publisher.id } : {}),
      // A bot is the person's to install, so the skills it brings are on for their bots.
      approvedHash: hash,
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
  by: Installer,
): Promise<StoredInstall> {
  const tx = new Transaction(ports, id);
  try {
    const installed = await installIn(ports, tx, review, choices, by);
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
  by: Installer,
): Promise<StoredInstall> {
  if (review.type !== "spade-bot") return land(ports, tx, review, choices, by);
  const inspection = review.checked.inspection;
  if (inspection?.type !== "spade-bot") throw new Error("The recipe didn't pass its checks");
  if (!ports.spade.ready()) throw new Error("Spade isn't running. Start Spade to make this bot.");
  const skills: string[] = [];
  const plugins: string[] = [];
  for (const brought of review.brings) {
    const current = ports.store.install(brought.type, brought.name);
    // A bot is the person's to install, so a skill it brings is on for their bots too, also one
    // already installed at these bytes by someone else and waiting to be turned on.
    if (
      !current ||
      current.hash !== brought.hash ||
      current.state !== "on" ||
      !approvedForBots(current)
    )
      await land(ports, tx, brought, { bots: [], needs: {}, startRoutines: false }, "person");
    (brought.type === "spade-skill" ? skills : plugins).push(brought.name);
  }
  skills.push(...(await landFolders(ports, tx, review, inspection.folders)));
  // The recipe's bytes are pinned before the bot exists, so a made bot always has them.
  await step(ports);
  await ports.store.pin(review.hash, "spade-bot", review.checked.files);
  const { recipe } = inspection;
  const linked: PackageInput | undefined =
    recipe.version === 3
      ? {
          manifest: bytesJson(review.checked.files),
          pages: panelPageTexts(recipe.surfaces, review.checked.files),
          code: codeBytes(recipe.code, review.checked.files),
          signed:
            review.signedManifest === undefined
              ? undefined
              : {
                  package: {
                    source: review.source,
                    name: review.name,
                    version: review.version,
                    hash: review.hash,
                  },
                  signedManifest: review.signedManifest,
                  botJson: bytesText(review.checked.files),
                  contractFiles: contractTexts(review.checked.files),
                },
        }
      : undefined;
  // A linked bot keeps its version's signed manifest, and the one before, for a later move.
  const signedRecord = (before?: StoredInstall) =>
    linked
      ? {
          ...(review.signedManifest === undefined ? {} : { signedManifest: review.signedManifest }),
          ...(before?.signedManifest === undefined
            ? {}
            : { previousSignedManifest: before.signedManifest }),
        }
      : {};
  // An update or rollback of a linked bot moves that bot; nothing new is made (ADR 0200 §6.1).
  if (review.updating) {
    if (!linked) throw new Error("Only a bot from a version 3 package updates");
    const bot = review.updating.bot;
    const before = ports.store.install(review.type, review.name, bot);
    await step(ports);
    const moved = await ports.spade.updateBot(bot, { ...linked, transaction: tx.id });
    tx.learned();
    await step(ports);
    const next = record(review, ports.now(), {
      target: bot,
      linked: true,
      ...signedRecord(before),
      ...(before ? { previous: { version: before.version, hash: before.hash } } : {}),
    });
    // Held for the end of the bot's turn: the record stays the version Spade runs, and says
    // which one waits (ADR 0200 §6.1). It becomes `next` once Spade runs it.
    if (moved.held && before) {
      const { waiting: _earlier, ...running } = before;
      return saveRecord(ports, tx, { ...running, waiting: next });
    }
    return saveRecord(ports, tx, next);
  }
  const granted = grantedNeeds(recipeNeeds(recipe), choices.needs);
  await step(ports);
  const made = tx.note({ kind: "bot", transaction: tx.id });
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
    ...(linked
      ? { linked: { ...linked, switches: grantedEffects(recipe, choices.effects ?? {}) } }
      : {}),
  });
  if (made.kind === "bot") made.id = bot.id;
  tx.learned();
  await step(ports);
  return saveRecord(
    ports,
    tx,
    record(review, ports.now(), {
      target: bot.id,
      ...(linked ? { linked: true, ...signedRecord() } : {}),
    }),
  );
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
    case "spade-bot":
      // A linked bot is paused with the reason, nothing deleted (ADR 0200 §6.1); one made from a
      // version 2 recipe is the person's and is left alone.
      if (install.linked && install.target)
        await ports.spade.withdrawBot(
          install.target,
          install.reason ?? "Its version was withdrawn.",
        );
      return;
    case "spade-skill":
    case "ace-plugin":
      // A skill leaves Spade's list by its state.
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
    case "spade-bot":
      await ports.store.pinned(install.hash, install.type);
      if (install.linked && install.target) await ports.spade.resumeBot(install.target);
      return;
    case "spade-skill":
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
  ports.store.removeInstallKeepingProvenance(install);
  await ports.store.collect();
}
