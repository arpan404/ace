import { join } from "node:path";
import type { MarketInstalled, MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { privacySpans, withSentences } from "@ace/marketplace";
import { homeOf, publicInstall, readListed, searchListings } from "./browse.ts";
import { applyBlocklist, turnOnUnlessBlocked } from "./blocklist.ts";
import { discover, publisherPage, report } from "./discover.ts";
import { GitCatalogs } from "./git.ts";
import { MarketHttp } from "./http.ts";
import { removeInstall } from "./install.ts";
import { undoJournal } from "./journal.ts";
import { readWithdrawn, refreshSource, type RowMarks } from "./listings.ts";
import { marketError as error, thrownError } from "./market-error.ts";
import { OpenReviews } from "./open-reviews.ts";
import type { MarketplaceOptions, MarketRequestPorts } from "./options.ts";
import { botRecipe, listPublishables, type PickPorts } from "./pick.ts";
import { withMarketInstalls } from "./pick-ports.ts";
import { MarketPictures } from "./pictures.ts";
import { markOwnProfile } from "./own-profile.ts";
import { publishRequest } from "./publish-request.ts";
import { saveGitSource, sourcesOf } from "./sources.ts";
import { spadeBot } from "./spade-bot.ts";
import { spadeSkillFiles, spadeSkills } from "./spade-skills.ts";
import { MarketStore } from "./store.ts";
import { badgesOf, Trust } from "./trust.ts";
import { TurnedOff } from "./turned-off.ts";
import { markUpdates, turnOffWithdrawn } from "./upkeep.ts";
import { holdsUpdates, reconcileBots, settleHeldUpdates } from "./arrived-bots.ts";

export type { MarketPluginPort, MarketplaceOptions, MarketRequestPorts } from "./options.ts";

/*
 * The daemon's marketplace (ADR 0168): the one fetcher and reviewer for every type and source.
 * Listings are read into the daemon's own copy, so search runs on the machine and works offline;
 * accepted bytes are pinned and checked on every read; each type lands with its owner.
 */

const staleMs = 60 * 60_000;
const dayMs = 24 * 60 * 60_000;

export class MarketplaceService {
  readonly #options: MarketplaceOptions;
  readonly #store: MarketStore;
  readonly #git: GitCatalogs;
  readonly #trust: Trust;
  readonly #reviews: OpenReviews;
  readonly #pictures = new MarketPictures();
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
      gate: () => this.#gate(),
    });
    this.#reviews = new OpenReviews({
      store,
      git: this.#git,
      trust: this.#trust,
      keys: options.keys,
      now: options.now,
      id: options.id,
      spade: options.spade,
      plugins: () => options.plugins(),
      http: () => this.#http(),
      installPorts: () => this.#installPorts(),
      recover: () => this.#recover(),
      enforceBlocklist: () => this.#enforceBlocklist(),
      emit: () => this.#emit(),
    });
  }

  /** Throws `TurnedOff` while Settings › Beta has the marketplace off. */
  async #gate(): Promise<void> {
    if (this.#options.enabled && !(await this.#options.enabled())) throw new TurnedOff();
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
      // Off, the refresh stops at its first fetch; the next day tries again. In turn with every
      // install, so a bot made meanwhile is never read as gone.
      void this.#serial(() => this.#refreshAll())
        .catch(() => {})
        .finally(() => this.#daily(dayMs));
    }, ms);
  }

  #http(): MarketHttp | undefined {
    const market = this.#store.source("market");
    return market?.enabled
      ? new MarketHttp({
          origin: this.#options.origin,
          fetch: async (url, init) => {
            await this.#gate();
            return this.#options.fetch(url, init);
          },
        })
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

  /** What list rows' marks rest on: the signed lists and the manifests this device verified. */
  #marks(): RowMarks {
    return {
      badges: badgesOf(this.#trust.current()),
      verified: this.#store.verifiedPublishers(),
    };
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
      gate: () => this.#gate(),
    };
  }

  /** Mutations run one at a time, in order. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    // Queued before the marketplace was turned off, a job still doesn't start once it is.
    const start = () => this.#gate().then(run);
    const next = this.#queue.then(start, start);
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

  /**
   * Whether installing the open review `id` for the bytes `hash` lands content only: a Suit or
   * a Spade skill carrying nothing runnable (ADR 0178 §12.8). Read from the review this daemon
   * built, never from the request.
   */
  installIsContentOnly(id: string, hash: string): boolean {
    return this.#reviews.contentOnly(id, hash);
  }

  async request(operation: MarketOperation, ports: MarketRequestPorts = {}): Promise<MarketResult> {
    try {
      await this.#gate();
      return await this.#handle(operation, ports);
    } catch (thrown) {
      return thrownError(thrown);
    }
  }

  /** The picker's ports, answering what this service installed itself (`pick-ports.ts`). */
  #pick(names: readonly string[] = []): PickPorts | undefined {
    const pick = this.#options.pick;
    return pick ? withMarketInstalls(pick, this.#store, names) : undefined;
  }

  async #handle(operation: MarketOperation, ports: MarketRequestPorts): Promise<MarketResult> {
    this.#reviews.sweep();
    switch (operation.op) {
      case "sources":
        return sourcesOf(this.#store);
      case "addSource":
        return this.#serial(() => this.#addSource(operation.address));
      case "removeSource":
        if (operation.id === "market")
          return error("invalid", "market.acehq.dev can be turned off, not removed");
        await this.#serial(() => this.#store.removeSource(operation.id));
        return sourcesOf(this.#store);
      case "setSource": {
        const source = this.#store.source(operation.id);
        if (!source) return error("not_found", "There is no such source");
        this.#store.saveSource({ ...source, enabled: operation.enabled });
        return sourcesOf(this.#store);
      }
      case "refresh":
        await this.#serial(() => this.#refreshAll(operation.id));
        return sourcesOf(this.#store);
      case "search":
        this.#refreshIfStale();
        return searchListings(this.#store, operation, this.#marks());
      case "home":
        this.#refreshIfStale();
        return homeOf(this.#store, this.#installed(), this.#marks());
      case "read":
        return readListed(
          { store: this.#store, http: this.#http(), keys: this.#options.keys },
          () => this.#marks(),
          operation.source,
          operation.type,
          operation.name,
        );
      case "prepare":
        return this.#serial(() =>
          this.#reviews.prepare(
            operation.source,
            operation.type,
            operation.name,
            operation.version,
          ),
        );
      case "readReview":
        return this.#reviews.read(operation.id, operation.offset);
      case "install":
        return this.#serial(() =>
          this.#reviews.install(
            operation.id,
            operation.hash,
            operation.choices,
            ports.withoutPerson === true ? "without-person" : "person",
          ),
        );
      case "cancel":
        await this.#reviews.cancel(operation.id);
        return { op: "done" };
      case "installed":
        // An update Spade held for a bot's turn shows as installed once Spade runs it.
        if (holdsUpdates(this.#store))
          await this.#serial(async () => {
            const spade = this.#options.spade;
            if (await settleHeldUpdates({ store: this.#store, spade })) this.#emit();
          }).catch(() => {});
        return { op: "installed", installed: this.#installed() };
      case "turnOnForBots":
        return this.#serial(async () => {
          const install = this.#store.install("spade-skill", operation.name);
          if (!install) return error("not_found", "That skill isn't installed");
          // Exactly the version the person looked at: one installed since is turned on anew.
          if (install.hash !== operation.hash)
            return error("conflict", "A newer version of this skill was installed. Look again.");
          this.#store.saveInstall({ ...install, approvedHash: install.hash });
          this.#emit();
          return { op: "done" };
        });
      case "prepareUpdate": {
        const install = this.#installOf(operation);
        if ("op" in install) return install;
        // A linked bot's update moves that bot (ADR 0200 §6.1).
        const bot = install.type === "spade-bot" && install.linked ? install.target : undefined;
        return this.#serial(() =>
          this.#reviews.prepare(install.source, install.type, install.name, install.update, bot),
        );
      }
      case "prepareRollback": {
        const install = this.#installOf(operation);
        if ("op" in install) return install;
        return this.#serial(() => this.#reviews.prepareRollback(install));
      }
      case "remove":
        return this.#serial(async () => {
          const install = this.#installOf(operation);
          if ("op" in install) return install;
          await removeInstall(this.#installPorts(), install);
          this.#emit();
          return { op: "done" };
        });
      case "turnOn":
        return this.#serial(() => this.#turnOn(operation));
      case "spadeSkills":
        return spadeSkills(this.#store);
      case "spadeSkillFiles":
        return spadeSkillFiles(this.#store, operation.name, operation.path);
      case "spadeBot":
        return spadeBot(
          {
            store: this.#store,
            fetch: (name, version) => this.#reviews.fetchVersion("market", name, version),
          },
          operation.name,
        );
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
        return markOwnProfile(
          await publishRequest(
            {
              http: this.#http(),
              grant: ports.grant,
              personGrant: ports.personGrant,
              pick: () => this.#pick(ports.names),
              suits: () => this.#options.suits(),
            },
            operation.request,
          ),
          this.#marks().badges,
        );
      case "publishables": {
        const pick = this.#pick();
        if (!pick) return error("unavailable", "Publishing isn't set up on this machine");
        return listPublishables(pick, operation.type);
      }
      case "privacyCheck": {
        const pick = this.#pick(ports.names);
        const names = pick ? await pick.names() : [];
        return {
          op: "privacyCheck",
          spans: operation.texts.map((text) =>
            withSentences(privacySpans(text, { names }).slice(0, 200)),
          ),
        };
      }
      case "botRecipe": {
        const pick = this.#pick();
        if (!pick) return error("unavailable", "Publishing isn't set up on this machine");
        return botRecipe(pick, operation.id);
      }
      case "report":
        return report(this.#http(), operation);
      case "picture": {
        const http = this.#http();
        if (!http) return error("unavailable", "market.acehq.dev is turned off");
        return this.#pictures.read(http, operation.kind, operation.hash);
      }
    }
  }

  /**
   * The install an operation names. A bot package can have made several bots here, one install
   * each: then the operation names its bot.
   */
  #installOf(key: { type: string; name: string; bot?: string | undefined }) {
    if (key.type === "spade-bot" && key.bot === undefined) {
      const installs = this.#store.botInstalls(key.name);
      if (installs.length > 1)
        return error("invalid", "More than one bot was made from this package; say which");
    }
    return (
      this.#store.install(key.type, key.name, key.bot) ??
      error("not_found", "That entry isn't installed")
    );
  }

  async #turnOn(key: {
    type: string;
    name: string;
    bot?: string | undefined;
  }): Promise<MarketResult> {
    const install = this.#installOf(key);
    if ("op" in install) return install;
    const on = await turnOnUnlessBlocked(
      () => this.#installPorts(),
      install,
      this.#trust.current().blocklist,
    );
    if (!on) return error("blocked", install.reason ?? "This is blocked");
    this.#emit();
    return { op: "done", installed: publicInstall(on) };
  }

  async #addSource(address: string): Promise<MarketResult> {
    const source = saveGitSource(this.#store, address, {
      id: this.#options.id,
      allowLocalGit: this.#options.allowLocalGit === true,
    });
    if ("op" in source) return source;
    await refreshSource(this.#deps(), source);
    // The read may have learned a newer blocklist; what is installed answers to it now.
    if (await this.#enforceBlocklist().catch(() => false)) this.#emit();
    return sourcesOf(this.#store);
  }

  async #refreshAll(id?: string): Promise<void> {
    this.#refreshing ??= (async () => {
      for (const source of this.#store.sources())
        if (source.enabled && (!id || source.id === id)) await refreshSource(this.#deps(), source);
      // Every refresh checks installs against the stored list, not only when a newer one
      // arrives, so a pass a failure or crash cut short is finished here.
      await this.#enforceBlocklist();
      const withdrawn = readWithdrawn(this.#store);
      await this.#reviews.cancelWithdrawn(withdrawn);
      // A linked bot a move brought here becomes an install here, with its pinned bytes; one
      // that moved away is the other machine's; an update Spade held becomes the version run.
      await reconcileBots({
        store: this.#store,
        spade: this.#options.spade,
        now: this.#options.now,
        fetch: (source, name, version) => this.#reviews.fetchVersion(source, name, version),
      });
      await turnOffWithdrawn(() => this.#installPorts(), this.#store, withdrawn);
      await markUpdates(this.#store);
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

  #installed(): MarketInstalled[] {
    return this.#store.installs().map((install) => publicInstall(install));
  }
}
