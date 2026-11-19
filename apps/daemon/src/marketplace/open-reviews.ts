import type { WithdrawalTarget } from "@ace/marketplace";
import type { ScanContext } from "@ace/marketplace/scan";
import type { MarketKeySet, MarketPublisher, MarketResult } from "@ace/protocol/marketplace";
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
import { prepareWithBrings, Refused } from "./prepare.ts";
import { publicInstall } from "./browse.ts";
import { contentOnlyReview } from "./content-only.ts";
import { buildReview, reviewPage, type PreparedReview } from "./review.ts";
import { verifiedKey, type MarketStore } from "./store.ts";
import { badgesOf, type Trust } from "./trust.ts";

/*
 * The reviews the service holds open between `prepare` and `install` (ADR 0168): each names the
 * verified bytes the person reads, expires after 30 minutes as ADR 0103's do, and installs only
 * if nothing withdrawn or blocked since the review is among what it brings.
 */

const reviewLifetimeMs = 30 * 60_000;
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
  ): Promise<MarketResult> {
    const { store } = this.#ports;
    const source = store.source(sourceId);
    if (!source || !source.enabled) return error("not_found", "That source isn't on");
    if (this.#pending.size >= maxPending)
      return error("busy", "Too many reviews are open; finish or cancel one");
    const plugins = this.#ports.plugins();
    const scanContext = await this.#scanContext();
    const ports = {
      badges: badgesOf(this.#ports.trust.current()),
      scanContext,
      http: this.#ports.http(),
      git: this.#ports.git,
      keys: this.#ports.keys,
      withdrawal: (target: WithdrawalTarget) =>
        withdrawalOf(readWithdrawn(store), source.id, target),
      preparePlugin: (input: Parameters<PluginPort["prepareFiles"]>[0]) => {
        if (!plugins) throw new Refused("Plugins aren't ready", { code: "unavailable" });
        return plugins.prepareFiles(input);
      },
    };
    const { entry, brings } = await prepareWithBrings(ports, store, source, type, name, version);
    // Each manifest prepare verified names its publisher: list rows may now show its marks.
    for (const prepared of [entry, ...brings])
      if (prepared.source === "market" && prepared.signed && prepared.publisher)
        store.saveVerifiedPublisher(verifiedKey(prepared), prepared.publisher.id);
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
    const built = buildReview(review);
    this.#pending.set(review.id, { review, items: built.items });
    return { op: "review", review: built.review };
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
    const previous = this.#ports.store.install(review.type, review.name);
    return contentOnlyReview(review, buildReview(review).review.body, previous);
  }

  async install(
    id: string,
    hash: string,
    choices: Parameters<typeof installReview>[2],
    by: Installer,
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
