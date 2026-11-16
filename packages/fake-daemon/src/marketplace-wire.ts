import type {
  MarketCategory,
  MarketClientMessage,
  MarketEntrySummary,
  MarketInstallChoices,
  MarketInstalled,
  MarketOperation,
  MarketResult,
  MarketReview,
  MarketReviewItem,
  MarketScanReport,
  MarketServerMessage,
  MarketSource,
} from "@ace/protocol/marketplace";
import { search } from "@ace/marketplace";
import { FakeMarketPublishing, type MarketPublishSeed } from "./marketplace-publish.ts";

/*
 * The marketplace (ADR 0168) as the fake daemon answers it: seeded listings searched on the
 * "machine", a canned review per type, and installs that move entries into Installed. Enough to
 * build and test the marketplace UI against without a market or a network.
 */

export interface FakeMarketEntry {
  summary: MarketEntrySummary;
  description?: string;
  /** The review `prepare` answers with; a plain one per type when absent. */
  review?: Partial<MarketReview>;
  items?: MarketReviewItem[];
  /** Its listed version was withdrawn, for this reason; `prepare` refuses it. */
  withdrawn?: string;
  /** The device's scan blocks its bytes: `prepare` answers `blocked` with this report. */
  blocked?: MarketScanReport;
}

/** An install the person accepted: the review's bytes and the choices sent with Install. */
export interface FakeMarketAcceptance {
  review: MarketReview;
  choices: MarketInstallChoices;
}

export interface MarketplaceSeed {
  entries?: FakeMarketEntry[];
  featured?: { type: string; name: string }[];
  categories?: MarketCategory[];
  installed?: MarketInstalled[];
  sources?: MarketSource[];
  /** When the listings were last read; absent means just now. */
  readAt?: number;
  /** A `prepare` for these `type/name` keys is refused with this message. */
  refuse?: Record<string, string>;
  /** Publishing, Discover and publisher pages (ADR 0173). */
  publishing?: MarketPublishSeed;
  /** Listing pictures and avatars the `picture` op answers, by sha256. */
  pictures?: Record<string, { type: "image/png" | "image/jpeg" | "image/webp"; data: string }>;
}

const hash = (seed: string) =>
  [...seed.padEnd(64, "0")]
    .map((char) => (char.charCodeAt(0) % 16).toString(16))
    .join("")
    .slice(0, 64);
const key = (type: string, name: string) => `${type}/${name}`;

function plainReview(entry: FakeMarketEntry, id: string, now: number): MarketReview {
  const { summary } = entry;
  const body: MarketReview["body"] =
    summary.type === "suit"
      ? { type: "suit", passes: true, problems: [], scenes: [], fonts: [], files: 2 }
      : summary.type === "spade-plugin"
        ? { type: "spade-plugin", pluginName: summary.name, executions: 1, unsupported: 0 }
        : summary.type === "spade-bot"
          ? {
              type: "spade-bot",
              botName: summary.title,
              task: "You look after the person's inbox.",
              model: "fast",
              routines: [
                {
                  name: "Morning sort",
                  instruction: "Sort the inbox.",
                  schedule: "weekdays at 8:00",
                },
              ],
              notes: [],
              brings: [],
              needs: [
                {
                  key: "connector:gmail",
                  kind: "connector",
                  label: "gmail",
                  why: "Reads mail.",
                  required: true,
                },
              ],
              spadeReady: true,
            }
          : {
              type: "spade-skill",
              skillName: summary.name,
              description: summary.line,
              files: 1,
              flagged: 0,
            };
  return {
    id,
    source: summary.source,
    type: summary.type as MarketReview["type"],
    name: summary.name,
    title: summary.title,
    version: summary.version ?? "1.0.0",
    hash: hash(summary.name),
    ...(summary.publisher ? { publisher: summary.publisher } : {}),
    ...(summary.from ? { from: summary.from } : {}),
    signed: summary.source === "market",
    reviewed: summary.reviewed,
    byAce: summary.byAce,
    body,
    expiresAt: now + 30 * 60_000,
    items: 0,
    ...entry.review,
  };
}

export class FakeMarketplaceWire {
  #entries = new Map<string, FakeMarketEntry>();
  #featured: { type: string; name: string }[] = [];
  #categories: MarketCategory[] = [];
  #installed = new Map<string, MarketInstalled>();
  #sources: MarketSource[] = [
    {
      id: "market",
      kind: "market",
      address: "https://market.acehq.dev",
      enabled: true,
      entries: 0,
    },
  ];
  #reviews = new Map<string, { review: MarketReview; items: MarketReviewItem[] }>();
  #refuse: Record<string, string> = {};
  #pictures: NonNullable<MarketplaceSeed["pictures"]> = {};
  #readAt: number | undefined;
  #counter = 0;
  readonly #now: () => number;
  readonly #listeners = new Set<(message: MarketServerMessage) => void>();
  /** Every install the person accepted, oldest first. */
  readonly accepted: FakeMarketAcceptance[] = [];
  /** Makes the bot a recipe's install asks Spade for; its id becomes the install's target. */
  makeBot: ((acceptance: FakeMarketAcceptance) => string | undefined) | undefined;

  /** Publishing, Discover, publisher pages and the reports sent. */
  readonly publishing: FakeMarketPublishing;

  constructor(now: () => number = () => 1_700_000_000_000) {
    this.#now = now;
    this.publishing = new FakeMarketPublishing(now);
  }

  seed(seed: MarketplaceSeed): void {
    for (const entry of seed.entries ?? [])
      this.#entries.set(
        `${entry.summary.source}:${key(entry.summary.type, entry.summary.name)}`,
        entry,
      );
    this.#featured = seed.featured ?? this.#featured;
    this.#categories = seed.categories ?? this.#categories;
    for (const item of seed.installed ?? []) this.#installed.set(key(item.type, item.name), item);
    if (seed.sources) this.#sources = seed.sources;
    this.#refuse = seed.refuse ?? this.#refuse;
    this.#readAt = seed.readAt;
    if (seed.pictures) this.#pictures = { ...this.#pictures, ...seed.pictures };
    if (seed.publishing) this.publishing.seed(seed.publishing);
  }

  /** Hears `marketplace.changed` after installs and removals. */
  subscribe(listener: (message: MarketServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    const installed = [...this.#installed.values()];
    const message: MarketServerMessage = {
      type: "marketplace.changed",
      installed: installed.length,
      updates: installed.filter((item) => item.update).length,
    };
    for (const listener of this.#listeners) listener(message);
  }

  handle(message: MarketClientMessage): MarketServerMessage {
    return {
      type: "marketplace.result",
      requestId: message.requestId,
      result: this.#answer(message.operation),
    };
  }

  #summaries(): MarketEntrySummary[] {
    const enabled = new Set(
      this.#sources.filter((source) => source.enabled).map((source) => source.id),
    );
    return [...this.#entries.values()]
      .map((entry) => entry.summary)
      .filter((summary) => enabled.has(summary.source));
  }

  #answer(operation: MarketOperation): MarketResult {
    const now = this.#now();
    switch (operation.op) {
      case "sources":
      case "refresh":
        return {
          op: "sources",
          sources: this.#sources.map((source) => ({
            ...source,
            readAt: this.#readAt ?? now,
            entries: [...this.#entries.values()].filter(
              (entry) => entry.summary.source === source.id,
            ).length,
          })),
        };
      case "addSource": {
        if (!operation.address.startsWith("https://"))
          return {
            op: "error",
            code: "invalid",
            message: "A catalog is added by its https git address",
          };
        this.#sources.push({
          id: `git:fake${++this.#counter}`,
          kind: "git",
          address: operation.address,
          enabled: true,
          entries: 0,
        });
        return this.#answer({ op: "sources" });
      }
      case "removeSource":
        this.#sources = this.#sources.filter(
          (source) => source.id !== operation.id || source.id === "market",
        );
        return this.#answer({ op: "sources" });
      case "setSource":
        for (const source of this.#sources)
          if (source.id === operation.id) source.enabled = operation.enabled;
        return this.#answer({ op: "sources" });
      case "search": {
        const found = search(this.#summaries(), operation);
        return {
          op: "search",
          entries: found.slice(operation.offset, operation.offset + operation.limit),
          total: found.length,
          readAt: this.#readAt ?? now,
        };
      }
      case "home": {
        const summaries = this.#summaries();
        const installed = [...this.#installed.values()];
        return {
          op: "home",
          featured: this.#featured.flatMap((item) =>
            summaries.filter(
              (summary) =>
                summary.reviewed && summary.type === item.type && summary.name === item.name,
            ),
          ),
          categories: this.#categories.map((category) => ({
            id: category.id,
            title: category.title,
            entries: summaries.filter(
              (summary) => summary.reviewed && summary.categories.includes(category.id),
            ).length,
          })),
          installed: installed.length,
          updates: installed.filter((item) => item.update).length,
        };
      }
      case "read": {
        const entry = this.#entries.get(
          `${operation.source}:${key(operation.type, operation.name)}`,
        );
        if (!entry)
          return {
            op: "error",
            code: "not_found",
            message: `${operation.type}/${operation.name} isn't listed`,
          };
        const installed = this.#installed.get(key(operation.type, operation.name));
        return {
          op: "read",
          entry: {
            summary: entry.summary,
            description: entry.description ?? entry.summary.line,
            versions: [
              {
                version: entry.summary.version ?? "1.0.0",
                hash: hash(entry.summary.name),
                size: 2048,
                published: now,
                downloads: entry.summary.downloads,
                ...(entry.withdrawn ? { withdrawn: entry.withdrawn } : {}),
              },
            ],
            ...(installed ? { installed } : {}),
          },
        };
      }
      case "prepare":
      case "prepareUpdate": {
        const source =
          operation.op === "prepare"
            ? operation.source
            : (this.#installed.get(key(operation.type, operation.name))?.source ?? "market");
        const entry = this.#entries.get(`${source}:${key(operation.type, operation.name)}`);
        const refused = this.#refuse[key(operation.type, operation.name)];
        if (refused) return { op: "error", code: "refused", message: refused };
        if (!entry)
          return {
            op: "error",
            code: "not_found",
            message: `${operation.type}/${operation.name} isn't listed`,
          };
        if (entry.withdrawn) return { op: "error", code: "refused", message: entry.withdrawn };
        if (entry.blocked)
          return {
            op: "error",
            code: "blocked",
            message: `${operation.type}/${operation.name} was refused by ace's scan on this device`,
            scan: entry.blocked,
          };
        const replaces =
          operation.op === "prepareUpdate"
            ? this.#installed.get(key(operation.type, operation.name))?.version
            : undefined;
        const review = {
          ...plainReview(entry, `review-${++this.#counter}`, now),
          ...(replaces ? { updates: replaces } : {}),
        };
        const items = entry.items ?? [];
        this.#reviews.set(review.id, { review: { ...review, items: items.length }, items });
        return { op: "review", review: { ...review, items: items.length } };
      }
      case "readReview": {
        const stored = this.#reviews.get(operation.id);
        if (!stored)
          return {
            op: "error",
            code: "expired",
            message: "That review has expired; prepare it again",
          };
        return {
          op: "reviewPage",
          review: stored.review,
          items: stored.items.slice(operation.offset),
        };
      }
      case "install": {
        const stored = this.#reviews.get(operation.id);
        if (!stored)
          return {
            op: "error",
            code: "expired",
            message: "That review has expired; prepare it again",
          };
        if (stored.review.hash !== operation.hash)
          return {
            op: "error",
            code: "conflict",
            message: "The review names other bytes than the install",
          };
        if (stored.review.blocked)
          return { op: "error", code: "refused", message: stored.review.blocked };
        const { review } = stored;
        const acceptance = { review, choices: operation.choices };
        this.accepted.push(acceptance);
        const bot = review.type === "spade-bot" ? this.makeBot?.(acceptance) : undefined;
        const installed: MarketInstalled = {
          source: review.source,
          type: review.type,
          name: review.name,
          title: review.title,
          version: review.version,
          hash: review.hash,
          acceptedAt: now,
          state: "on",
          target: review.type === "spade-bot" ? (bot ?? `bot_${this.#counter}`) : review.name,
        };
        this.#installed.set(key(review.type, review.name), installed);
        this.#reviews.delete(operation.id);
        this.#changed();
        return { op: "done", installed };
      }
      case "cancel":
        this.#reviews.delete(operation.id);
        return { op: "done" };
      case "installed":
        return { op: "installed", installed: [...this.#installed.values()] };
      case "remove":
        if (!this.#installed.delete(key(operation.type, operation.name)))
          return { op: "error", code: "not_found", message: "That entry isn't installed" };
        this.#changed();
        return { op: "done" };
      case "turnOn": {
        const item = this.#installed.get(key(operation.type, operation.name));
        if (!item) return { op: "error", code: "not_found", message: "That entry isn't installed" };
        const { reason: _reason, ...rest } = item;
        const on: MarketInstalled = { ...rest, state: "on" };
        this.#installed.set(key(item.type, item.name), on);
        this.#changed();
        return { op: "done", installed: on };
      }
      case "spadeSkills":
        return {
          op: "spadeSkills",
          skills: [...this.#installed.values()]
            .filter((item) => item.type === "spade-skill" && item.state === "on")
            .map((item) => ({
              name: item.name,
              version: item.version,
              hash: item.hash,
              description: item.title,
            })),
        };
      case "spadeSkillFiles":
        return { op: "spadeSkillFiles", files: [] };
      case "discover":
        return this.publishing.discover(
          this.#summaries().filter((summary) => summary.source === "market"),
        );
      case "publisher":
        return this.publishing.publisher(operation.handle);
      case "publish":
        return this.publishing.publish(operation.request);
      case "report":
        return this.publishing.report(operation);
      case "picture": {
        const picture = this.#pictures[operation.hash];
        return picture
          ? { op: "picture", ...picture }
          : { op: "error", code: "not_found", message: "There is no such picture" };
      }
    }
  }
}
