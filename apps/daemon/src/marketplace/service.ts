import { join } from "node:path";
import type { MarketInstalled, MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import type { WithdrawalTarget } from "@ace/marketplace";
import { type MarketKeySet } from "@ace/protocol/marketplace";
import type { GitRuntime } from "@ace/plugins";
import { homeOf, publicInstall, readEntry, searchListings } from "./browse.ts";
import { GitCatalogs } from "./git.ts";
import { MarketHttp, type MarketFetch } from "./http.ts";
import { undoJournal } from "./journal.ts";
import {
  installReview,
  removeInstall,
  turnOff,
  turnOn,
  type PluginPort,
  type SpadePort,
  type SuitPort,
} from "./install.ts";
import { learnWithdrawn, readWithdrawn, refreshSource, withdrawalOf } from "./listings.ts";
import { applyBlocklist, blockedEntry, blockedFindings } from "./blocklist.ts";
import { discover, publisherPage, report } from "./discover.ts";
import { publishAction, type MarketGrantPort } from "./publish.ts";
import { badgesOf, Trust } from "./trust.ts";
import type { MarketPublisher } from "@ace/protocol/marketplace";
import type { ScanContext } from "@ace/marketplace/scan";
import { newer, prepareWithBrings, Refused } from "./prepare.ts";
import { buildReview, reviewPage, type PreparedReview } from "./review.ts";
import { MarketStore, verifiedKey, type StoredSource } from "./store.ts";
import type { RowMarks } from "./listings.ts";

/*
 * The daemon's marketplace (ADR 0168): the one fetcher and reviewer for every type and source.
 * Listings are read into the daemon's own copy, so search runs on the machine and works offline;
 * accepted bytes are pinned and checked on every read; each type lands with its owner.
 */

/** The plugin manager as the marketplace uses it (`plugin-port.ts`). */
export type MarketPluginPort = PluginPort;

export interface MarketplaceOptions {
  root: string;
  now: () => number;
  id: () => string;
  fetch: MarketFetch;
  /** https://market.acehq.dev; another origin only through the development setting. */
  origin: string;
  keys: MarketKeySet;
  git: GitRuntime;
  suits: () => SuitPort | undefined;
  plugins: () => MarketPluginPort | undefined;
  spade: SpadePort;
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (run: () => void, ms: number) => () => void;
  /** Tests add catalogs by local path; people add https addresses only. */
  allowLocalGit?: boolean;
}

const reviewLifetimeMs = 30 * 60_000;
const staleMs = 60 * 60_000;
const dayMs = 24 * 60 * 60_000;
const maxPending = 32;

interface Pending {
  review: PreparedReview;
  items: ReturnType<typeof buildReview>["items"];
}

const error = (
  code: Extract<MarketResult, { op: "error" }>["code"],
  message: string,
  problems?: Refused["problems"],
  scan?: Refused["scan"],
): MarketResult => ({
  op: "error",
  code,
  message: message.slice(0, 2000),
  ...(problems?.length ? { problems: problems.slice(0, 200) } : {}),
  ...(scan ? { scan } : {}),
});

/** What one request may use beyond the service's own ports. */
export interface MarketRequestPorts {
  /** Mints a market grant for a `publish` action; absent or undefined answers `signed_out`. */
  grant?: MarketGrantPort | undefined;
}

export class MarketplaceService {
  readonly #options: MarketplaceOptions;
  readonly #store: MarketStore;
  readonly #git: GitCatalogs;
  readonly #trust: Trust;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<(counts: { installed: number; updates: number }) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  #refreshing: Promise<void> | undefined;
  #cancelTimer: (() => void) | undefined;
  #closed = false;

  private constructor(options: MarketplaceOptions, store: MarketStore) {
    this.#options = options;
    this.#store = store;
    this.#trust = new Trust(store, options.keys);
    this.#git = new GitCatalogs({
      root: join(options.root, "git"),
      runtime: options.git,
      id: options.id,
    });
  }

  static async open(options: MarketplaceOptions): Promise<MarketplaceService> {
    const store = await MarketStore.open(options.root);
    if (!store.source("market"))
      store.saveSource({
        id: "market",
        kind: "market",
        address: new URL(options.origin).origin,
        enabled: true,
      });
    const service = new MarketplaceService(options, store);
    await service.#git.collect();
    // An install a crash interrupted is undone before anything else runs.
    await service.#recover();
    // A blocklist saved before a crash, or one a pass couldn't finish, is enforced now.
    await service.#enforceBlocklist().catch(() => {});
    const last = Math.min(...store.sources().map((source) => source.readAt ?? 0));
    service.#daily(options.now() - last > dayMs ? 5 * 60_000 : dayMs);
    return service;
  }

  close(): void {
    this.#closed = true;
    this.#cancelTimer?.();
    this.#listeners.clear();
    this.#store.close();
  }

  /** `listener` hears the installed and update counts after anything changes them. */
  subscribe(listener: (counts: { installed: number; updates: number }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #daily(ms: number): void {
    this.#cancelTimer = this.#options.schedule(() => {
      if (this.#closed) return;
      void this.#refreshAll().finally(() => this.#daily(dayMs));
    }, ms);
  }

  #http(): MarketHttp | undefined {
    const market = this.#store.source("market");
    return market?.enabled
      ? new MarketHttp({ origin: this.#options.origin, fetch: this.#options.fetch })
      : undefined;
  }

  #deps() {
    return {
      store: this.#store,
      http: this.#http(),
      git: this.#git,
      keys: this.#options.keys,
      trust: this.#trust,
      now: this.#options.now,
    };
  }

  #badges() {
    return badgesOf(this.#trust.current());
  }

  /** What list rows' marks rest on: the signed lists and the manifests this device verified. */
  #marks(): RowMarks {
    return { badges: this.#badges(), verified: this.#store.verifiedPublishers() };
  }

  /** Every install not yet blocked, checked against the stored signed blocklist. */
  async #enforceBlocklist(): Promise<boolean> {
    return await applyBlocklist(this.#installPorts(), this.#trust.current().blocklist);
  }

  #installPorts() {
    return {
      store: this.#store,
      suits: this.#options.suits(),
      plugins: this.#options.plugins(),
      spade: this.#options.spade,
      now: this.#options.now,
    };
  }

  /** Mutations run one at a time, in order. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  #emit(): void {
    const installed = this.#installed();
    const counts = {
      installed: installed.length,
      updates: installed.filter((item) => item.update).length,
    };
    for (const listener of this.#listeners) listener(counts);
  }

  async request(operation: MarketOperation, ports: MarketRequestPorts = {}): Promise<MarketResult> {
    try {
      return await this.#handle(operation, ports);
    } catch (thrown) {
      if (thrown instanceof Refused)
        return error(thrown.code, thrown.message, thrown.problems, thrown.scan);
      return error("failed", thrown instanceof Error ? thrown.message : "The marketplace failed");
    }
  }

  async #handle(operation: MarketOperation, ports: MarketRequestPorts): Promise<MarketResult> {
    this.#sweep();
    switch (operation.op) {
      case "sources":
        return this.#sources();
      case "addSource":
        return this.#serial(() => this.#addSource(operation.address));
      case "removeSource":
        if (operation.id === "market")
          return error("invalid", "market.acehq.dev can be turned off, not removed");
        await this.#serial(() => this.#store.removeSource(operation.id));
        return this.#sources();
      case "setSource": {
        const source = this.#store.source(operation.id);
        if (!source) return error("not_found", "There is no such source");
        this.#store.saveSource({ ...source, enabled: operation.enabled });
        return this.#sources();
      }
      case "refresh":
        await this.#serial(() => this.#refreshAll(operation.id));
        return this.#sources();
      case "search":
        return this.#search(operation);
      case "home":
        return this.#home();
      case "read":
        return this.#read(operation.source, operation.type, operation.name);
      case "prepare":
        return this.#serial(() =>
          this.#prepare(operation.source, operation.type, operation.name, operation.version),
        );
      case "readReview": {
        const pending = this.#pending.get(operation.id);
        if (!pending) return error("expired", "That review has expired; prepare it again");
        return {
          op: "reviewPage",
          review: buildReview(pending.review).review,
          ...reviewPage(pending.items, operation.offset),
        };
      }
      case "install":
        return this.#serial(() => this.#install(operation.id, operation.hash, operation.choices));
      case "cancel":
        await this.#cancel(operation.id);
        return { op: "done" };
      case "installed":
        return { op: "installed", installed: this.#installed() };
      case "prepareUpdate": {
        const install = this.#store.install(operation.type, operation.name);
        if (!install) return error("not_found", "That entry isn't installed");
        return this.#serial(() =>
          this.#prepare(install.source, install.type, install.name, install.update),
        );
      }
      case "remove":
        return this.#serial(async () => {
          const install = this.#store.install(operation.type, operation.name);
          if (!install) return error("not_found", "That entry isn't installed");
          await removeInstall(this.#installPorts(), install);
          this.#emit();
          return { op: "done" };
        });
      case "turnOn":
        return this.#serial(async () => {
          const install = this.#store.install(operation.type, operation.name);
          if (!install) return error("not_found", "That entry isn't installed");
          if (install.state === "blocked") {
            // Blocked bytes stay off while the newest verified blocklist still names them.
            const found = await blockedFindings(
              this.#installPorts(),
              install,
              this.#trust.current().blocklist,
            );
            if (found.length > 0) return error("blocked", install.reason ?? "This is blocked");
          }
          await turnOn(this.#installPorts(), install);
          const { reason: _reason, ...rest } = install;
          this.#store.saveInstall({ ...rest, state: "on" });
          this.#emit();
          return { op: "done", installed: publicInstall({ ...rest, state: "on" }) };
        });
      case "spadeSkills":
        return {
          op: "spadeSkills",
          skills: this.#store
            .installs()
            .filter((install) => install.type === "spade-skill" && install.state === "on")
            .map((install) => ({
              name: install.name,
              version: install.version,
              hash: install.hash,
              description: install.description.slice(0, 1024),
            })),
        };
      case "spadeSkillFiles":
        return this.#spadeFiles(operation.name, operation.path);
      case "discover":
        return discover(
          {
            store: this.#store,
            http: this.#http(),
            marks: this.#marks(),
            now: this.#options.now,
          },
          this.#store.source("market"),
        );
      case "publisher":
        return publisherPage(
          { http: this.#http(), marks: this.#marks() },
          this.#store.source("market"),
          operation.handle,
        );
      case "publish":
        return publishAction({ http: this.#http(), grant: ports.grant }, operation.request);
      case "report":
        return report(this.#http(), operation);
    }
  }

  async #sources(): Promise<MarketResult> {
    const sources: Extract<MarketResult, { op: "sources" }>["sources"] = [];
    for (const source of this.#store.sources())
      sources.push({
        id: source.id,
        kind: source.kind,
        address: source.address,
        enabled: source.enabled,
        ...(source.readAt === undefined ? {} : { readAt: source.readAt }),
        ...(source.problem ? { problem: source.problem } : {}),
        entries: (await this.#store.listing(source.id)).entries.length,
      });
    return { op: "sources", sources };
  }

  async #addSource(address: string): Promise<MarketResult> {
    const local = this.#options.allowLocalGit === true && address.startsWith("/");
    if (!local) {
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        return error("invalid", "A catalog is added by its https git address");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        return error(
          "invalid",
          "A catalog is added by its https git address, with no password in it",
        );
    }
    if (this.#store.sources().some((source) => source.address === address))
      return error("conflict", "That catalog is already added");
    if (this.#store.sources().length >= 32) return error("refused", "At most 32 sources");
    const id = `git:${
      this.#options
        .id()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 32) || "catalog"
    }`;
    const source: StoredSource = { id, kind: "git", address, enabled: true };
    this.#store.saveSource(source);
    await refreshSource(this.#deps(), source);
    // The read may have learned a newer blocklist; what is installed answers to it now.
    if (await this.#enforceBlocklist().catch(() => false)) this.#emit();
    return this.#sources();
  }

  async #refreshAll(id?: string): Promise<void> {
    this.#refreshing ??= (async () => {
      for (const source of this.#store.sources())
        if (source.enabled && (!id || source.id === id)) await refreshSource(this.#deps(), source);
      // Every refresh checks installs against the stored list, not only when a newer one
      // arrives, so a pass a failure or crash cut short is finished here.
      await this.#enforceBlocklist();
      await this.#applyWithdrawals();
      await this.#checkUpdates();
      this.#emit();
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** A stale listing is read again in the background; the answer uses what the daemon has. */
  #refreshIfStale(): void {
    const now = this.#options.now();
    if (
      this.#store.sources().some((source) => source.enabled && now - (source.readAt ?? 0) > staleMs)
    )
      void this.#serial(() => this.#refreshAll()).catch(() => {});
  }

  /** Undoes every install a failure or crash left journaled; what can't be undone now waits. */
  async #recover(): Promise<void> {
    for (const journal of this.#store.journals())
      await undoJournal(this.#installPorts(), journal).catch(() => false);
  }

  #transactionId(): string {
    return `install-${this.#options
      .id()
      .replace(/[^a-zA-Z0-9-]/g, "")
      .slice(0, 60)}`;
  }

  /**
   * After an install was undone, the plugin reviews it accepted are spent: ask ADR 0014's
   * manager for new ones over the same verified bytes, so the person can press Install again.
   */
  async #renewPluginReviews(review: PreparedReview): Promise<void> {
    const plugins = this.#options.plugins();
    if (!plugins) return;
    for (const entry of [review, ...review.brings]) {
      if (!entry.plugin || !entry.pluginInput) continue;
      await plugins.cancel(entry.plugin.id).catch(() => {});
      entry.plugin = await plugins.prepareFiles(entry.pluginInput).catch(() => entry.plugin);
    }
  }

  async #applyWithdrawals(): Promise<void> {
    const state = readWithdrawn(this.#store);
    // A review of withdrawn bytes, or of a recipe that brings them, ends here.
    for (const [id, pending] of this.#pending)
      if (
        [pending.review, ...pending.review.brings].some((entry) =>
          withdrawalOf(state, entry.source, entry),
        )
      )
        await this.#cancel(id);
    for (const install of this.#store.installs()) {
      const reason = withdrawalOf(state, install.source, install);
      if (!reason || install.state !== "on" || install.type === "spade-bot") continue;
      await turnOff(this.#installPorts(), install);
      this.#store.saveInstall({ ...install, state: "withdrawn", reason: reason.slice(0, 500) });
    }
  }

  /** Marks each installed entry its source offers a newer version of; never applies one. */
  async #checkUpdates(): Promise<void> {
    const listings = new Map<string, Awaited<ReturnType<MarketStore["listing"]>>>();
    for (const install of this.#store.installs()) {
      if (install.type === "spade-bot" || install.bundledBy) continue;
      const listing = listings.get(install.source) ?? (await this.#store.listing(install.source));
      listings.set(install.source, listing);
      const listed = listing.entries.find(
        (entry) => entry.type === install.type && entry.name === install.name,
      );
      const offered = listed?.version;
      const update = offered && newer(offered, install.version) ? offered : undefined;
      // The index says whether its latest version is deprecated: it speaks for the installed
      // version only when that is the latest.
      const deprecated =
        install.source === "market" && listed?.version === install.version
          ? listed.deprecated?.slice(0, 500)
          : install.deprecated;
      if (update !== install.update || deprecated !== install.deprecated) {
        const { update: _old, deprecated: _note, ...rest } = install;
        this.#store.saveInstall({
          ...rest,
          ...(update ? { update } : {}),
          ...(deprecated ? { deprecated } : {}),
        });
      }
    }
  }

  async #search(operation: Extract<MarketOperation, { op: "search" }>): Promise<MarketResult> {
    this.#refreshIfStale();
    return searchListings(this.#store, operation, this.#marks());
  }

  async #home(): Promise<MarketResult> {
    this.#refreshIfStale();
    return homeOf(this.#store, this.#installed(), this.#marks());
  }

  async #read(sourceId: string, type: string, name: string): Promise<MarketResult> {
    const detail = await readEntry(
      { store: this.#store, http: this.#http(), keys: this.#options.keys },
      () => this.#marks(),
      sourceId,
      type,
      name,
    );
    if (!detail) return error("not_found", `${type}/${name} isn't listed`);
    const installed = this.#store.install(type, name);
    if (installed && installed.source === sourceId) detail.installed = publicInstall(installed);
    return { op: "read", entry: detail };
  }

  async #prepare(
    sourceId: string,
    type: string,
    name: string,
    version: string | undefined,
  ): Promise<MarketResult> {
    const source = this.#store.source(sourceId);
    if (!source || !source.enabled) return error("not_found", "That source isn't on");
    if (this.#pending.size >= maxPending)
      return error("busy", "Too many reviews are open; finish or cancel one");
    const plugins = this.#options.plugins();
    const scanContext = await this.#scanContext();
    const ports = {
      badges: this.#badges(),
      scanContext,
      http: this.#http(),
      git: this.#git,
      keys: this.#options.keys,
      withdrawal: (target: WithdrawalTarget) =>
        withdrawalOf(readWithdrawn(this.#store), source.id, target),
      preparePlugin: (input: Parameters<MarketPluginPort["prepareFiles"]>[0]) => {
        if (!plugins) throw new Refused("Plugins aren't ready", { code: "unavailable" });
        return plugins.prepareFiles(input);
      },
    };
    const { entry, brings } = await prepareWithBrings(
      ports,
      this.#store,
      source,
      type,
      name,
      version,
    );
    // Each manifest prepare verified names its publisher: list rows may now show its marks.
    for (const prepared of [entry, ...brings])
      if (prepared.source === "market" && prepared.signed && prepared.publisher)
        this.#store.saveVerifiedPublisher(verifiedKey(prepared), prepared.publisher.id);
    const review: PreparedReview = {
      ...entry,
      id: this.#options
        .id()
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 80),
      expiresAt: this.#options.now() + reviewLifetimeMs,
      brings,
      spadeReady: entry.type === "spade-bot" ? this.#options.spade.ready() : true,
    };
    const built = buildReview(review);
    this.#pending.set(review.id, { review, items: built.items });
    return { op: "review", review: built.review };
  }

  /** What the device's scan compares against: every listed entry, the signed lists. */
  async #scanContext(): Promise<(publisher: MarketPublisher | undefined) => ScanContext> {
    const trust = this.#trust.current();
    const badges = badgesOf(trust);
    const entries: ScanContext["entries"][number][] = [];
    for (const source of this.#store.sources())
      for (const entry of (await this.#store.listing(source.id)).entries)
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

  async #install(
    id: string,
    hash: string,
    choices: Parameters<typeof installReview>[2],
  ): Promise<MarketResult> {
    const pending = this.#pending.get(id);
    if (!pending) return error("expired", "That review has expired; prepare it again");
    if (pending.review.hash !== hash)
      return error("conflict", "The review names other bytes than the install");
    const built = buildReview(pending.review);
    if (built.review.blocked) return error("refused", built.review.blocked);
    if (pending.review.type === "spade-bot" && !this.#options.spade.ready())
      return error("unavailable", "Spade isn't running. Start Spade to make this bot.");
    await this.#recover();
    // A withdrawal learned since the review counts: for the entry and for all it brings.
    await learnWithdrawn(this.#store, this.#http(), this.#options.keys).catch(() => {});
    const state = readWithdrawn(this.#store);
    for (const entry of [pending.review, ...pending.review.brings]) {
      const reason = withdrawalOf(state, entry.source, entry);
      if (!reason) continue;
      await this.#cancel(id);
      return error(
        "refused",
        `${entry.type}/${entry.name} ${entry.version} was withdrawn: ${reason}`,
      );
    }
    // So does a block: the bytes of the entry and of all it brings, against the newest list.
    const learned = await this.#trust.learn(this.#http()).catch(() => undefined);
    // A newer list also answers for what is already installed, not only for this install.
    if (learned?.blocklist && (await this.#enforceBlocklist().catch(() => false))) this.#emit();
    const blocked = blockedEntry(
      [pending.review, ...pending.review.brings],
      this.#trust.current().blocklist,
    );
    if (blocked) {
      await this.#cancel(id);
      return error("blocked", `Blocked by ace's market: ${blocked}`);
    }
    let installed;
    try {
      installed = await installReview(
        this.#installPorts(),
        pending.review,
        choices,
        this.#transactionId(),
      );
    } catch (thrown) {
      await this.#renewPluginReviews(pending.review);
      throw thrown;
    }
    this.#pending.delete(id);
    if (pending.review.deprecated) {
      installed = { ...installed, deprecated: pending.review.deprecated.slice(0, 500) };
      this.#store.saveInstall(installed);
    }
    this.#emit();
    return { op: "done", installed: publicInstall(installed) };
  }

  async #cancel(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (!pending) return;
    const plugins = this.#options.plugins();
    for (const entry of [pending.review, ...pending.review.brings])
      if (entry.plugin) await plugins?.cancel(entry.plugin.id).catch(() => {});
  }

  /** Reviews expire after 30 minutes, as ADR 0103's do. */
  #sweep(): void {
    const now = this.#options.now();
    for (const [id, pending] of this.#pending)
      if (pending.review.expiresAt <= now) void this.#cancel(id);
  }

  #installed(): MarketInstalled[] {
    return this.#store.installs().map((install) => publicInstall(install));
  }

  async #spadeFiles(name: string, path: string | undefined): Promise<MarketResult> {
    const install = this.#store.install("spade-skill", name);
    if (!install || install.state !== "on")
      return error("not_found", `There is no market skill ${name}`);
    const files = await this.#store.pinned(install.hash, "spade-skill");
    const list = install.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      hash: file.sha256,
      executable: file.executable,
    }));
    if (path === undefined) return { op: "spadeSkillFiles", files: list };
    const file = files.find((item) => item.path === path);
    if (!file) return error("not_found", `${name} has no file ${path}`);
    return {
      op: "spadeSkillFiles",
      files: list.filter((item) => item.path === path),
      content: Buffer.from(file.content).toString("base64"),
    };
  }
}
