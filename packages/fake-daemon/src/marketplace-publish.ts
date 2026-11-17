import type {
  MarketDiscover,
  MarketDraft,
  MarketEntrySummary,
  MarketMe,
  MarketOperation,
  MarketOwnEntry,
  MarketOwnVersion,
  MarketProfile,
  MarketPublishAction,
  MarketPublishAnswer,
  MarketPublisherPage,
  MarketResult,
  MarketScanReport,
  MarketSignals,
  MarketVerificationStatus,
} from "@ace/protocol/marketplace";
import { report } from "@ace/marketplace/scan";

/*
 * Publishing, Discover, publisher pages and reports (ADR 0173) as the fake daemon answers them,
 * from seeded state: the publisher's page, entries with version statuses, drafts whose scan runs
 * (`scanning` on create, `done` on the next read), publishes held or blocked, signals,
 * verification and transfers. Signed out when seeded so. No market and no network.
 */

export interface MarketPublishSeed {
  /** Every `publish` answers `signed_out`. */
  signedOut?: boolean;
  me?: MarketMe;
  entries?: MarketOwnEntry[];
  signals?: Record<string, MarketSignals>;
  verification?: MarketVerificationStatus;
  /** A draft's publish by id: held for a maintainer, or blocked with this scan. */
  publishing?: Record<string, "held" | { blocked: MarketScanReport }>;
  /**
   * The scans a draft of `type/name` finishes with, in turn: each new scan takes the next and
   * the last one stays. Absent, every scan passes.
   */
  scans?: Record<string, MarketScanReport[]>;
  /** Discover; absent builds one from the seeded listings. */
  discover?: Omit<MarketDiscover, "readAt">;
  publishers?: MarketPublisherPage[];
}

type ErrorResult = Extract<MarketResult, { op: "error" }>;
const failure = (code: ErrorResult["code"], message: string, extra: Partial<ErrorResult> = {}) =>
  ({ op: "error", code, message, ...extra }) satisfies ErrorResult;
const ok = (answer: MarketPublishAnswer): MarketResult => ({ op: "publish", answer });
const key = (item: { type: string; name: string }) => `${item.type}/${item.name}`;
const fakeHash = (seed: string) =>
  [...seed.padEnd(64, "0")]
    .map((char) => (char.charCodeAt(0) % 16).toString(16))
    .join("")
    .slice(0, 64);

/** A clean scan of `files` files, as the market's scanner would report it. */
export const passedScan = (hash: string, files = 1): MarketScanReport =>
  report([], { files, textBytes: files * 400 }, hash);

const emptyMe: MarketMe = {
  state: "active",
  newPublisher: true,
  limits: {
    uploadsToday: 0,
    uploadsPerDay: 10,
    storedBytes: 0,
    quotaBytes: 256 * 1024 * 1024,
    drafts: 0,
    draftLimit: 20,
  },
  entries: [],
  drafts: [],
  transfers: [],
};

export class FakeMarketPublishing {
  #signedOut = false;
  #me: MarketMe = structuredClone(emptyMe);
  #entries = new Map<string, MarketOwnEntry>();
  #signals: Record<string, MarketSignals> = {};
  #verification: MarketVerificationStatus = {
    verified: false,
    proofs: [],
    state: "none",
    challenges: [],
  };
  #publishing: NonNullable<MarketPublishSeed["publishing"]> = {};
  #scans: NonNullable<MarketPublishSeed["scans"]> = {};
  #discover: MarketPublishSeed["discover"];
  #publishers = new Map<string, MarketPublisherPage>();
  #counter = 0;
  readonly #now: () => number;
  /** Every report the person sent, oldest first. */
  readonly reports: Extract<MarketOperation, { op: "report" }>[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  seed(seed: MarketPublishSeed): void {
    if (seed.signedOut !== undefined) this.#signedOut = seed.signedOut;
    if (seed.me) this.#me = structuredClone(seed.me);
    for (const entry of seed.entries ?? []) this.#entries.set(key(entry.summary), entry);
    if (seed.signals) this.#signals = seed.signals;
    if (seed.verification) this.#verification = seed.verification;
    if (seed.publishing) this.#publishing = seed.publishing;
    if (seed.scans) this.#scans = structuredClone(seed.scans);
    if (seed.discover) this.#discover = seed.discover;
    for (const page of seed.publishers ?? []) this.#publishers.set(page.profile.handle, page);
  }

  discover(listed: readonly MarketEntrySummary[]): MarketResult {
    const now = this.#now();
    const discover: MarketDiscover = this.#discover
      ? { ...this.#discover, readAt: now }
      : {
          ...(listed[0] ? { hero: listed[0] } : {}),
          featured: listed.filter((entry) => entry.reviewed).slice(0, 24),
          trending: listed.slice(0, 10).map((entry, index) => ({
            entry,
            rank: index + 1,
            movement: index === 0 ? { kind: "new" } : { kind: "same" },
            week: entry.downloads,
          })),
          fresh: listed.toSorted((a, b) => b.updated - a.updated).slice(0, 24),
          collections: [],
          publishers: [],
          rankedAt: now,
          readAt: now,
        };
    return { op: "discover", discover };
  }

  publisher(handle: string): MarketResult {
    const page = this.#publishers.get(handle);
    return page
      ? { op: "publisher", page }
      : failure("not_found", `There is no publisher ${handle}`);
  }

  report(operation: Extract<MarketOperation, { op: "report" }>): MarketResult {
    this.reports.push(operation);
    return { op: "done" };
  }

  publish(action: MarketPublishAction): MarketResult {
    if (this.#signedOut) return failure("signed_out", "Sign in to publish.");
    switch (action.action) {
      case "me":
        return ok({ kind: "me", me: this.#page() });
      case "createProfile": {
        if (this.#me.profile) return failure("conflict", "This account already has a profile");
        const profile: MarketProfile = {
          id: "pub_fake",
          handle: action.profile.handle,
          displayName: action.profile.displayName,
          bio: action.profile.bio,
          links: action.profile.links,
          joined: this.#now(),
          verified: false,
          proofs: [],
          pins: [],
        };
        this.#me.profile = profile;
        return ok({ kind: "profile", profile });
      }
      case "editProfile":
      case "changeHandle":
      case "setAvatar":
      case "setPins": {
        const profile = this.#me.profile;
        if (!profile) return failure("not_found", "Make a profile first");
        if (action.action === "editProfile") Object.assign(profile, action.profile);
        if (action.action === "changeHandle") profile.handle = action.handle;
        if (action.action === "setAvatar") profile.avatar = fakeHash(action.image.slice(0, 32));
        if (action.action === "setPins") profile.pins = action.entries;
        return ok({ kind: "profile", profile });
      }
      case "draftCreate": {
        const draft: MarketDraft = {
          id: `drf_fake${String(++this.#counter).padStart(4, "0")}`,
          type: action.type,
          name: action.name,
          version: action.version,
          hash: fakeHash(`${action.name}${action.version}`),
          size: 2048,
          files: 3,
          created: this.#now(),
          updated: this.#now(),
          changelog: action.changelog ?? "",
          title: action.name,
          problems: [],
          scan: { state: "scanning", read: 1, files: 3 },
        };
        this.#me.drafts.push(draft);
        return ok({ kind: "draft", draft });
      }
      case "draftRead":
      case "draftUpdate": {
        const draft = this.#me.drafts.find((item) => item.id === action.id);
        if (!draft) return failure("not_found", "There is no such draft");
        if (action.action === "draftUpdate") {
          if (action.version) draft.version = action.version;
          if (action.changelog !== undefined) draft.changelog = action.changelog;
          if (action.source) draft.scan = { state: "scanning", read: 0, files: draft.files };
          draft.updated = this.#now();
        } else if (draft.scan.state === "scanning")
          // The scan finishes by the next read, as the Worker's steps would.
          draft.scan = { state: "done", report: this.#nextScan(draft) };
        return ok({ kind: "draft", draft });
      }
      case "draftDelete":
        this.#me.drafts = this.#me.drafts.filter((item) => item.id !== action.id);
        return ok({ kind: "done" });
      case "draftPublish":
        return this.#publishDraft(action.id);
      case "transferAnswer":
        this.#me.transfers = this.#me.transfers.filter((item) => item.id !== action.id);
        return ok({ kind: "me", me: this.#page() });
      case "verification":
        return ok({ kind: "verification", verification: this.#verification });
      case "applyVerification":
        this.#verification = {
          ...this.#verification,
          state: "applied",
          challenges: [action.domain, action.github].flatMap((subject, index) =>
            subject
              ? [
                  {
                    kind: index === 0 ? ("domain" as const) : ("github" as const),
                    subject,
                    token: "fake-proof-token-0123456789abcdefghijklmnop",
                    expiresAt: this.#now() + 48 * 3_600_000,
                    state: "waiting" as const,
                  },
                ]
              : [],
          ),
        };
        return ok({ kind: "verification", verification: this.#verification });
      case "checkVerification":
        this.#verification = {
          ...this.#verification,
          challenges: this.#verification.challenges.map((item) => ({ ...item, state: "passed" })),
        };
        return ok({ kind: "verification", verification: this.#verification });
      default:
        return this.#onEntry(action);
    }
  }

  #nextScan(draft: MarketDraft): MarketScanReport {
    const queued = this.#scans[key(draft)];
    const next = queued && queued.length > 1 ? queued.shift() : queued?.[0];
    return next ?? passedScan(draft.hash, draft.files);
  }

  #page(): MarketMe {
    return {
      ...this.#me,
      entries: [...this.#entries.values()].map((entry) => entry.summary),
      limits: { ...this.#me.limits, drafts: this.#me.drafts.length },
    };
  }

  #publishDraft(id: string): MarketResult {
    const draft = this.#me.drafts.find((item) => item.id === id);
    if (!draft) return failure("not_found", "There is no such draft");
    if (draft.scan.state === "scanning")
      return failure("conflict", "The draft is still being scanned");
    if (draft.scan.report.verdict === "block")
      return failure("blocked", "The scan refused this version", { scan: draft.scan.report });
    const outcome = this.#publishing[id];
    if (typeof outcome === "object")
      return failure("blocked", "The scan refused this version", { scan: outcome.blocked });
    const held = outcome === "held";
    const version: MarketOwnVersion = {
      version: draft.version,
      hash: draft.hash,
      size: draft.size,
      published: this.#now(),
      status: "waiting",
      held,
      changelog: draft.changelog,
      downloads: 0,
      scan: draft.scan.report,
    };
    const existing = this.#entries.get(key(draft));
    this.#entries.set(key(draft), {
      summary: {
        type: draft.type,
        name: draft.name,
        title: draft.title,
        line: "",
        versions: (existing?.versions.length ?? 0) + 1,
        visibility: "listed",
        archived: false,
        pinned: false,
        reviewed: false,
        downloads: 0,
        pendingListing: false,
        openReports: 0,
        ...existing?.summary,
        version: draft.version,
        status: "waiting",
      },
      listing: existing?.listing ?? {
        title: draft.title,
        line: "",
        description: "",
        categories: [],
        keywords: [],
        links: [],
        previews: [],
      },
      versions: [version, ...(existing?.versions ?? [])],
    });
    this.#me.drafts = this.#me.drafts.filter((item) => item.id !== id);
    const { type, name } = draft;
    return ok({ kind: "published", type, name, version: draft.version, held });
  }

  #onEntry(action: Extract<MarketPublishAction, { type: string; name: string }>): MarketResult {
    const entry = this.#entries.get(key(action));
    if (!entry) return failure("not_found", `${action.type}/${action.name} isn't yours`);
    const version = (v: string) => entry.versions.find((item) => item.version === v);
    switch (action.action) {
      case "entry":
        break;
      case "signals": {
        const signals = this.#signals[key(action)];
        return signals
          ? ok({ kind: "signals", signals })
          : failure("not_found", "No signals for that entry yet");
      }
      case "listing":
        entry.listing = action.listing;
        entry.summary.title = action.listing.title;
        entry.summary.line = action.listing.line;
        break;
      case "preview":
        entry.listing.previews[action.index] = fakeHash(action.image.slice(0, 32));
        break;
      case "changelog":
      case "deprecate":
      case "appeal": {
        const target = version(action.version);
        if (!target) return failure("not_found", `There is no version ${action.version}`);
        if (action.action === "changelog") target.changelog = action.text;
        if (action.action === "deprecate")
          if (action.note === null) delete target.deprecated;
          else target.deprecated = action.note;
        if (action.action === "appeal")
          target.appeal = {
            id: `apl_fake${String(++this.#counter).padStart(4, "0")}`,
            note: action.note,
            ...(action.replacement ? { replacement: action.replacement } : {}),
            at: this.#now(),
            state: "open",
          };
        break;
      }
      case "latest":
        if (action.version === null) delete entry.latest;
        else entry.latest = action.version;
        break;
      case "withdraw":
        for (const item of entry.versions)
          if (action.version === undefined || item.version === action.version) {
            item.status = "withdrawn";
            item.reason = action.reason;
          }
        break;
      case "deleteEntry":
        this.#entries.delete(key(action));
        return ok({ kind: "done" });
      case "visibility":
        entry.summary.visibility = action.visibility;
        break;
      case "archive":
        entry.summary.archived = action.archived;
        break;
      case "transfer":
        this.#me.transfers.push({
          id: `trf_fake${String(++this.#counter).padStart(4, "0")}`,
          type: action.type,
          name: action.name,
          from: this.#me.profile?.handle ?? "me",
          to: action.to,
          at: this.#now(),
          expiresAt: this.#now() + 7 * 86_400_000,
          direction: "outgoing",
        });
        break;
    }
    return ok({ kind: "entry", entry });
  }
}
