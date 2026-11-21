import type { WithdrawalTarget } from "@ace/marketplace";
import type { ScanContext } from "@ace/marketplace/scan";
import type {
  MarketBotReplay,
  MarketBotUpdate,
  MarketKeySet,
  MarketPublisher,
  MarketResult,
} from "@ace/protocol/marketplace";
import { blockedEntry } from "./blocklist.ts";
import type { GitCatalogs } from "./git.ts";
import type { MarketHttp } from "./http.ts";
import {
  installReview,
  type Installer,
  type InstallPorts,
  type PluginPort,
  type SpadePort,
} from "./install.ts";
import { learnWithdrawn, readWithdrawn, withdrawalOf, type WithdrawnState } from "./listings.ts";
import { marketError as error } from "./market-error.ts";
import { prepareEntry, prepareWithBrings, Refused, type PreparePorts } from "./prepare.ts";
import { publicInstall } from "./browse.ts";
import { contentOnlyReview } from "./content-only.ts";
import { reauthSentence } from "./fresh-sign-in.ts";
import { buildReview, reviewPage, type PreparedEntry, type PreparedReview } from "./review.ts";
import { verifiedKey, type MarketStore, type StoredInstall } from "./store.ts";
import { bytesJson, packageAsksMore } from "./package-diff.ts";
import { checkFiles, panelPageTexts } from "@ace/marketplace/checks";
import { badgesOf, type Trust } from "./trust.ts";
import type { RegistryReview } from "./org-registry.ts";

/*
 * The reviews the service holds open between `prepare` and `install` (ADR 0168): each names the
 * verified bytes the person reads, expires after 30 minutes as ADR 0103's do, and installs only
 * if nothing withdrawn or blocked since the review is among what it brings.
 */

const reviewLifetimeMs = 30 * 60_000;
/** The longest an update review waits on the free replay of the bot's kept runs. */
const replayBoundMs = 20_000;
const maxPending = 32;

interface Pending {
  review: PreparedReview;
  items: ReturnType<typeof buildReview>["items"];
}

export interface OpenReviewsPorts {
  store: MarketStore;
  git: GitCatalogs;
  trust: Trust;
  keys: MarketKeySet;
  now: () => number;
  id: () => string;
  spade: SpadePort;
  plugins: () => PluginPort | undefined;
  http: () => MarketHttp | undefined;
  installPorts: () => InstallPorts;
  /** Undoes every install a failure or crash left journaled. */
  recover: () => Promise<void>;
  /** Checks every install against the stored blocklist; true when it changed one. */
  enforceBlocklist: () => Promise<boolean>;
  /** Tells listeners the installed and update counts changed. */
  emit: () => void;
}

export class OpenReviews {
  readonly #ports: OpenReviewsPorts;
  readonly #pending = new Map<string, Pending>();

  constructor(ports: OpenReviewsPorts) {
    this.#ports = ports;
  }

  /** What the open review `id` installs from an organization's registry, if it does. */
  registryReview(id: string): RegistryReview | undefined {
    const review = this.#pending.get(id)?.review;
    if (!review?.registry) return undefined;
    return {
      org: review.registry,
      type: review.type,
      name: review.name,
      version: review.version,
      hash: review.hash,
      signedManifest: review.signedManifest,
    };
  }

  /** One page of an open review's items. */
  read(id: string, offset: number): MarketResult {
    const pending = this.#pending.get(id);
    if (!pending) return error("expired", "That review has expired; prepare it again");
    return {
      op: "reviewPage",
      review: buildReview(pending.review).review,
      ...reviewPage(pending.items, offset),
    };
  }

  async prepare(
    sourceId: string,
    type: string,
    name: string,
    version: string | undefined,
    /** An update of this linked bot (ADR 0200 §6.1). */
    bot?: string,
    /** From an organization's registry, read as a member (ADR 0206 §5.4). */
    registry?: PreparePorts["registry"],
  ): Promise<MarketResult> {
    const { store } = this.#ports;
    const source = store.source(sourceId);
    if (!source || !source.enabled) return error("not_found", "That source isn't on");
    if (registry && source.kind !== "market")
      return error("invalid", "Only market.acehq.dev has organizations' registries");
    if (this.#pending.size >= maxPending)
      return error("busy", "Too many reviews are open; finish or cancel one");
    const ports = { ...(await this.#preparePorts(source.id)), registry };
    const { entry, brings } = await prepareWithBrings(
      ports,
      store,
      source,
      type,
      name,
      version,
      bot,
    );
    // Each manifest prepare verified names its publisher: list rows may now show its marks.
    for (const prepared of [entry, ...brings])
      if (prepared.source === "market" && prepared.signed && prepared.publisher)
        store.saveVerifiedPublisher(verifiedKey(prepared), prepared.publisher.id);
    return this.#open(entry, brings, bot ? { bot, rollback: false } : undefined);
  }

  /** What fetching a version for review uses: the same checks for a review and a fetch. */
  async #preparePorts(sourceId: string): Promise<PreparePorts> {
    const { store } = this.#ports;
    const plugins = this.#ports.plugins();
    return {
      badges: badgesOf(this.#ports.trust.current()),
      scanContext: await this.#scanContext(),
      http: this.#ports.http(),
      git: this.#ports.git,
      keys: this.#ports.keys,
      spade: this.#ports.spade.version(),
      withdrawal: (target: WithdrawalTarget) =>
        withdrawalOf(readWithdrawn(store), sourceId, target),
      preparePlugin: (input: Parameters<PluginPort["prepareFiles"]>[0]) => {
        if (!plugins) throw new Refused("Plugins aren't ready", { code: "unavailable" });
        return plugins.prepareFiles(input);
      },
    };
  }

  /**
   * One version of a bot package fetched from its source and checked as a review checks it
   * (signature, hash, withdrawn list, ace's checks, the device's scan), without a review: what a
   * moved bot's pinned bytes are fetched by (ADR 0200 §3.8). Throws when the source refuses.
   */
  async fetchVersion(sourceId: string, name: string, version: string): Promise<PreparedEntry> {
    const source = this.#ports.store.source(sourceId);
    if (!source || !source.enabled) throw new Refused("That source isn't on");
    return prepareEntry(await this.#preparePorts(source.id), source, "spade-bot", name, version);
  }

  /**
   * A review of the version a linked bot had before (ADR 0200 §6.1), from the bytes pinned here:
   * checked again, and needing no network. Installing it is the person's, as an update is.
   */
  async prepareRollback(
    install: StoredInstall,
    /** The registry the earlier version came from, once its checks passed (ADR 0206 §5.4). */
    registry?: string,
  ): Promise<MarketResult> {
    const { store } = this.#ports;
    if (install.type !== "spade-bot" || !install.linked || !install.target)
      return error("invalid", "Only a bot from a version 3 package rolls back");
    if (!install.previous) return error("not_found", "There is no earlier version to go back to");
    if (this.#pending.size >= maxPending)
      return error("busy", "Too many reviews are open; finish or cancel one");
    const files = await store.pinned(install.previous.hash, "spade-bot");
    const checked = checkFiles("spade-bot", install.name, files, {
      spade: this.#ports.spade.version(),
    });
    if (checked.problems.length > 0 || checked.hash !== install.previous.hash)
      return error("refused", "The earlier version no longer passes ace's checks");
    const current = await store.pinned(install.hash, "spade-bot").catch(() => []);
    const entry: PreparedEntry = {
      source: install.source,
      type: "spade-bot",
      name: install.name,
      title: install.title,
      version: install.previous.version,
      hash: install.previous.hash,
      signed: install.signed ?? false,
      ...(install.previousSignedManifest === undefined
        ? {}
        : { signedManifest: install.previousSignedManifest }),
      reviewed: false,
      byAce: false,
      checked,
      previous: { version: install.version, files: current },
      ...(registry ? { registry } : {}),
    };
    return this.#open(entry, [], { bot: install.target, rollback: true });
  }

  async #open(
    entry: PreparedEntry,
    brings: PreparedEntry[],
    moving: { bot: string; rollback: boolean } | undefined,
  ): Promise<MarketResult> {
    const review: PreparedReview = {
      ...entry,
      id: this.#ports
        .id()
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 80),
      expiresAt: this.#ports.now() + reviewLifetimeMs,
      brings,
      spadeReady: entry.type === "spade-bot" ? this.#ports.spade.ready() : true,
    };
    review.modelWarning = await this.#modelWarning(entry);
    if (moving) {
      const updating = await this.#plan(review, moving);
      if ("op" in updating) return updating;
      review.updating = updating;
    }
    const built = buildReview(review);
    this.#pending.set(review.id, { review, items: built.items });
    return { op: "review", review: built.review };
  }

  /**
   * Why a bot that uses apps or agents may not be able to act (ADR 0205 §3): none of the models
   * it would think with calls tools. Nothing when it uses neither, or Spade can't say.
   */
  async #modelWarning(entry: PreparedEntry): Promise<string | undefined> {
    const inspection = entry.checked.inspection;
    if (inspection?.type !== "spade-bot" || inspection.recipe.version !== 3) return undefined;
    const uses = inspection.recipe.uses ?? [];
    if (!uses.includes("apps") && !uses.includes("agents")) return undefined;
    if (!this.#ports.spade.ready()) return undefined;
    const tools = await this.#ports.spade.packageTools().catch(() => undefined);
    if (!tools || tools[inspection.recipe.model]) return undefined;
    return "This bot works with apps and other agents, which takes a model that can call tools, and none of the models it would run on can. Add one in Settings › Spade › Models, or it won't be able to act.";
  }

  /** What moving the bot to the review's version does, by Spade's plan and the two manifests. */
  async #plan(
    review: PreparedReview,
    moving: { bot: string; rollback: boolean },
  ): Promise<MarketBotUpdate | MarketResult> {
    const next = review.checked.inspection;
    if (next?.type !== "spade-bot" || next.recipe.version !== 3)
      return error("invalid", "Only a bot from a version 3 package updates");
    if (!this.#ports.spade.ready())
      return error("unavailable", "Spade isn't running. Start Spade to update this bot.");
    const manifest = bytesJson(review.checked.files);
    const plan = await this.#ports.spade.planUpdate(moving.bot, manifest);
    const before = review.previous
      ? checkFiles("spade-bot", review.name, [...review.previous.files]).inspection
      : undefined;
    const asksMore =
      before?.type === "spade-bot" ? packageAsksMore(before.recipe, next.recipe) : [];
    const replay = await this.#replay(moving.bot, manifest, review);
    return {
      bot: moving.bot,
      rollback: moving.rollback,
      plan,
      asksMore,
      ...(replay ? { replay } : {}),
    };
  }

  /**
   * The bot's kept runs replayed free on the review's version (ADR 0204 §2), within a bound: a
   * replay that fails or takes too long leaves the review without its line, never holds it up.
   */
  async #replay(
    bot: string,
    manifest: unknown,
    review: PreparedReview,
  ): Promise<MarketBotReplay | undefined> {
    const replay = this.#ports.spade.replayUpdate;
    if (!replay) return undefined;
    const next = review.checked.inspection;
    const surfaces = next?.type === "spade-bot" ? next.recipe.surfaces : undefined;
    const pages = panelPageTexts(surfaces, review.checked.files);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), replayBoundMs);
    });
    try {
      const replayed = await Promise.race([
        replay.call(this.#ports.spade, bot, manifest, pages).catch(() => undefined),
        late,
      ]);
      return replayed && replayed.cases.length > 0 ? replayed : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the device's scan compares against: every listed entry, the signed lists. */
  async #scanContext(): Promise<(publisher: MarketPublisher | undefined) => ScanContext> {
    const { store } = this.#ports;
    const trust = this.#ports.trust.current();
    const badges = badgesOf(trust);
    const entries: ScanContext["entries"][number][] = [];
    for (const source of store.sources())
      for (const entry of (await store.listing(source.id)).entries)
        entries.push({
          type: entry.type,
          name: entry.name,
          publisher: entry.publisher?.name ?? "",
          downloads: entry.downloads,
        });
    const verified = (trust.verified?.publishers ?? []).map((publisher) => ({
      handle: publisher.handle,
      displayName: publisher.handle,
    }));
    return (publisher) => ({
      entries,
      verified,
      ...(publisher
        ? { publisher: { handle: publisher.name, official: badges.official(publisher.id) } }
        : {}),
      ...(trust.blocklist ? { blocklist: trust.blocklist } : {}),
    });
  }

  /**
   * Whether the open review `id`, for the bytes `hash`, installs content only
   * (`content-only.ts`): false for a review that is gone or names other bytes.
   */
  contentOnly(id: string, hash: string): boolean {
    const pending = this.#pending.get(id);
    if (!pending || pending.review.hash !== hash) return false;
    const { review } = pending;
    const previous = this.#ports.store.provenance(review.type, review.name);
    return contentOnlyReview(review, buildReview(review).review.body, previous);
  }

  async install(
    id: string,
    hash: string,
    choices: Parameters<typeof installReview>[2],
    by: Installer,
    /**
     * Throws when what authorized this install no longer holds (a registry's membership, its
     * grant's lifetime): run last, after every await before the install lands.
     */
    stillAllowed?: () => void,
  ): Promise<MarketResult> {
    const { store, trust } = this.#ports;
    const pending = this.#pending.get(id);
    if (!pending) return error("expired", "That review has expired; prepare it again");
    if (pending.review.hash !== hash)
      return error("conflict", "The review names other bytes than the install");
    const built = buildReview(pending.review);
    if (built.review.blocked) return error("refused", built.review.blocked);
    if (pending.review.type === "spade-bot" && !this.#ports.spade.ready())
      return error("unavailable", "Spade isn't running. Start Spade to make this bot.");
    await this.#ports.recover();
    // On the exemption, judged again here, in turn with every other install and after recovery:
    // an install that landed the same name since the gate looked is what this one replaces.
    if (by === "without-person" && !this.contentOnly(id, hash))
      return error("reauth", reauthSentence);
    // A withdrawal learned since the review counts: for the entry and for all it brings.
    await learnWithdrawn(store, this.#ports.http(), this.#ports.keys).catch(() => {});
    const state = readWithdrawn(store);
    for (const entry of [pending.review, ...pending.review.brings]) {
      const reason = withdrawalOf(state, entry.source, entry);
      if (!reason) continue;
      await this.cancel(id);
      return error(
        "refused",
        `${entry.type}/${entry.name} ${entry.version} was withdrawn: ${reason}`,
      );
    }
    // So does a block: the bytes of the entry and of all it brings, against the newest list.
    const learned = await trust.learn(this.#ports.http()).catch(() => undefined);
    // A newer list also answers for what is already installed, not only for this install.
    if (learned?.blocklist && (await this.#ports.enforceBlocklist().catch(() => false)))
      this.#ports.emit();
    const blocked = blockedEntry(
      [pending.review, ...pending.review.brings],
      trust.current().blocklist,
    );
    if (blocked) {
      await this.cancel(id);
      return error("blocked", `Blocked by ace's market: ${blocked}`);
    }
    // Recovery and the lists' refreshes above took time: authorization is judged as it is now,
    // with nothing awaited between it and the install.
    stillAllowed?.();
    let installed;
    try {
      installed = await installReview(
        this.#ports.installPorts(),
        pending.review,
        choices,
        this.#transactionId(),
        by,
      );
    } catch (thrown) {
      await this.#renewPluginReviews(pending.review);
      throw thrown;
    }
    this.#pending.delete(id);
    if (pending.review.deprecated) {
      installed = { ...installed, deprecated: pending.review.deprecated.slice(0, 500) };
      store.saveInstall(installed);
    }
    this.#ports.emit();
    return { op: "done", installed: publicInstall(installed) };
  }

  #transactionId(): string {
    return `install-${this.#ports
      .id()
      .replace(/[^a-zA-Z0-9-]/g, "")
      .slice(0, 60)}`;
  }

  /**
   * After an install was undone, the plugin reviews it accepted are spent: ask ADR 0014's
   * manager for new ones over the same verified bytes, so the person can press Install again.
   */
  async #renewPluginReviews(review: PreparedReview): Promise<void> {
    const plugins = this.#ports.plugins();
    if (!plugins) return;
    for (const entry of [review, ...review.brings]) {
      if (!entry.plugin || !entry.pluginInput) continue;
      await plugins.cancel(entry.plugin.id).catch(() => {});
      entry.plugin = await plugins.prepareFiles(entry.pluginInput).catch(() => entry.plugin);
    }
  }

  async cancel(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (!pending) return;
    const plugins = this.#ports.plugins();
    for (const entry of [pending.review, ...pending.review.brings])
      if (entry.plugin) await plugins?.cancel(entry.plugin.id).catch(() => {});
  }

  /** A review of withdrawn bytes, or of a recipe that brings them, ends here. */
  async cancelWithdrawn(state: WithdrawnState): Promise<void> {
    for (const [id, pending] of this.#pending)
      if (
        [pending.review, ...pending.review.brings].some((entry) =>
          withdrawalOf(state, entry.source, entry),
        )
      )
        await this.cancel(id);
  }

  /** Reviews expire after 30 minutes, as ADR 0103's do. */
  sweep(): void {
    const now = this.#ports.now();
    for (const [id, pending] of this.#pending)
      // cancel() already swallows a plugin cancellation failure.
      if (pending.review.expiresAt <= now) void this.cancel(id).catch(() => {});
  }
}
