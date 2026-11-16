import { z } from "zod";
import { PluginExecution, PluginName } from "./plugins.ts";
import {
  MarketCategory,
  MarketCategoryId,
  MarketEntryName,
  MarketEntrySummary,
  MarketEntryType,
  MarketEntryVersion,
  MarketHash,
  MarketProblem,
  MarketPublisher,
  MarketSourceId,
  MarketVersion,
} from "./marketplace-base.ts";

import { marketPublishOperations, marketPublishResults } from "./marketplace-publish-ops.ts";
import { MarketScanReport } from "./marketplace-scan.ts";

export * from "./marketplace-base.ts";
export * from "./marketplace-catalog.ts";
export * from "./marketplace-discover.ts";
export * from "./marketplace-publish-ops.ts";
export * from "./marketplace-publisher.ts";
export * from "./marketplace-scan.ts";
export * from "./marketplace-service.ts";
export * from "./marketplace-signed.ts";

/*
 * ace's marketplace on the wire (ADR 0168): the entry model both sources produce, the review a
 * `prepare` returns, and the `marketplace.request` / `marketplace.result` envelopes beside
 * ADR 0014's plugin ones. Schema only; parsing, ranking and verification live in
 * `@ace/marketplace`.
 */

const words = z.string().max(8192);

/** What turned an installed entry off. A withdrawn entry stays off until the person turns it on. */
/** `blocked`: its bytes match the signed blocklist (ADR 0173 §8); off until removed. */
export const MarketInstallState = z.enum(["on", "withdrawn", "blocked", "off"]);
export const MarketInstalled = z.strictObject({
  source: MarketSourceId,
  type: MarketEntryType,
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  version: z.string().max(64),
  hash: MarketHash,
  acceptedAt: z.number().int().nonnegative(),
  state: MarketInstallState,
  /** The signed withdrawal's or blocklist's reason, when `state` is `withdrawn` or `blocked`. */
  reason: z.string().max(500).optional(),
  /** Its publisher deprecated the installed version, with this note. */
  deprecated: z.string().max(500).optional(),
  /** A newer version its source offers; never applied without a new review. */
  update: MarketVersion.optional(),
  /** Where it landed: the Suit's id, the plugin's name, the bot's id. */
  target: z.string().max(200).optional(),
});
export type MarketInstalled = z.infer<typeof MarketInstalled>;

/** An entry's page: the summary, its description and its versions, newest first. */
export const MarketEntryDetail = z.strictObject({
  summary: MarketEntrySummary,
  description: words,
  versions: z.array(MarketEntryVersion).max(200),
  installed: MarketInstalled.optional(),
});
export type MarketEntryDetail = z.infer<typeof MarketEntryDetail>;

export const MarketSource = z.strictObject({
  id: MarketSourceId,
  kind: z.enum(["market", "git"]),
  /** https://market.acehq.dev, or the git catalog's https address. */
  address: z.string().max(2048),
  enabled: z.boolean(),
  /** When its listing was last read; absent before the first read. */
  readAt: z.number().int().nonnegative().optional(),
  /** Why the last read failed; the listing from `readAt` stays in use. */
  problem: z.string().max(500).optional(),
  entries: z.number().int().nonnegative(),
});
export type MarketSource = z.infer<typeof MarketSource>;

/* ---------------------------------------------------------------- reviews */

export const MarketReviewId = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);
export const MarketFileRow = z.strictObject({
  path: z.string().min(1).max(512),
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
  /** Executable, or not text: a script or binary the person should know about. */
  flagged: z.boolean(),
});
export type MarketFileRow = z.infer<typeof MarketFileRow>;

/** A connector or plugin a recipe asks for, as a switch on its review. */
export const MarketNeed = z.strictObject({
  /** `connector:<id>`, `connector:<https address>` or `plugin:<name>`. */
  key: z.string().min(1).max(2100),
  kind: z.enum(["connector", "plugin"]),
  label: z.string().max(2048),
  why: z.string().max(500),
  required: z.boolean(),
});
export type MarketNeed = z.infer<typeof MarketNeed>;

export const MarketRoutineRow = z.strictObject({
  name: z.string().max(120),
  instruction: z.string().max(4000),
  schedule: z.string().max(200),
});

/** What one type can do, in the facts its review page says in sentences. */
export const MarketReviewBody = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("suit"),
    passes: z.boolean(),
    problems: z.array(MarketProblem).max(200),
    scenes: z.array(z.string().max(40)).max(8),
    fonts: z.array(z.string().max(120)).max(16),
    files: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("spade-skill"),
    skillName: z.string().max(64),
    description: z.string().max(1024),
    files: z.number().int().nonnegative(),
    flagged: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("spade-plugin"),
    pluginName: PluginName,
    executions: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("spade-bot"),
    botName: z.string().max(80),
    face: z.record(z.string(), z.unknown()).optional(),
    task: z.string().max(8000),
    model: z.enum(["fast", "capable"]),
    routines: z.array(MarketRoutineRow).max(32),
    tools: z.array(z.string().max(64)).max(64).optional(),
    notes: z.array(z.string().max(2000)).max(50),
    /** Skills and plugins it brings, each reviewed in its own section (`readReview`). */
    brings: z
      .array(
        z.strictObject({
          type: MarketEntryType,
          name: MarketEntryName,
          version: z.string().max(64),
        }),
      )
      .max(32),
    needs: z.array(MarketNeed).max(64),
    /** Whether Spade is running to make the bot; installing waits for it otherwise. */
    spadeReady: z.boolean(),
  }),
]);
export type MarketReviewBody = z.infer<typeof MarketReviewBody>;

/** A review's summary, bounded; its files, texts and executions page through `readReview`. */
export const MarketReview = z.strictObject({
  id: MarketReviewId,
  source: MarketSourceId,
  type: MarketEntryType,
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  version: z.string().max(64),
  hash: MarketHash,
  publisher: MarketPublisher.optional(),
  from: z.string().max(2048).optional(),
  /** The manifest's signature checked against a shipped market key (never for git catalogs). */
  signed: z.boolean(),
  reviewed: z.boolean(),
  byAce: z.boolean(),
  /** This version replaces an installed one: what changed is in the pages. */
  updates: z.string().max(64).optional(),
  body: MarketReviewBody,
  /** No install is possible: a Suit that fails ace's checks, Spade not running for a recipe. */
  blocked: z.string().max(500).optional(),
  /** The device's own scan of these bytes (ADR 0173 §8): every finding, as sentences. */
  scan: MarketScanReport.optional(),
  /** Its publisher deprecated this version, with this note. */
  deprecated: z.string().max(500).optional(),
  /** Unlisted: reached by a link, not by search. */
  unlisted: z.boolean().optional(),
  expiresAt: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
});
export type MarketReview = z.infer<typeof MarketReview>;

/** One row of a review's pages, in order. `section` names a recipe's bundled entry. */
export const MarketReviewItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), section: z.string().max(120), file: MarketFileRow }),
  z.strictObject({
    kind: z.literal("text"),
    section: z.string().max(120),
    /** `SKILL.md`, `suit.json`, or such a file before an update (`before`). */
    path: z.string().max(512),
    text: z.string().max(65_536),
    before: z.boolean(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("execution"),
    section: z.string().max(120),
    execution: PluginExecution,
  }),
  z.strictObject({
    kind: z.literal("change"),
    section: z.string().max(120),
    path: z.string().max(512),
    change: z.enum(["added", "changed", "removed"]),
    executable: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("note"),
    section: z.string().max(120),
    text: z.string().max(2000),
  }),
]);
export type MarketReviewItem = z.infer<typeof MarketReviewItem>;

/** The person's choices on the review, sent with Install. */
export const MarketInstallChoices = z.strictObject({
  /** Spade bots a plugin is allowed for (ADR 0151 point 8). */
  bots: z.array(z.string().min(1).max(80)).max(64).default([]),
  /** A recipe's need switches as the person left them, by `MarketNeed.key`. */
  needs: z.record(z.string().max(2100), z.boolean()).default({}),
  /** A recipe's routines start running; off by default. */
  startRoutines: z.boolean().default(false),
});
export type MarketInstallChoices = z.infer<typeof MarketInstallChoices>;

/* ---------------------------------------------------------------- operations */

const entryKey = { source: MarketSourceId, type: z.string().min(1).max(40), name: MarketEntryName };
const installedKey = { type: MarketEntryType, name: MarketEntryName };

export const MarketOperation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("sources") }),
  z.strictObject({ op: z.literal("addSource"), address: z.string().min(1).max(2048) }),
  z.strictObject({ op: z.literal("removeSource"), id: MarketSourceId }),
  z.strictObject({ op: z.literal("setSource"), id: MarketSourceId, enabled: z.boolean() }),
  z.strictObject({ op: z.literal("refresh"), id: MarketSourceId.optional() }),
  z.strictObject({
    op: z.literal("search"),
    query: z.string().max(200).default(""),
    type: z.string().max(40).optional(),
    category: MarketCategoryId.optional(),
    source: MarketSourceId.optional(),
    offset: z.number().int().min(0).max(10_000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.strictObject({ op: z.literal("home") }),
  z.strictObject({ op: z.literal("read"), ...entryKey }),
  z.strictObject({ op: z.literal("prepare"), ...entryKey, version: MarketVersion.optional() }),
  z.strictObject({
    op: z.literal("readReview"),
    id: MarketReviewId,
    offset: z.number().int().min(0).max(100_000).default(0),
  }),
  z.strictObject({
    op: z.literal("install"),
    id: MarketReviewId,
    hash: MarketHash,
    choices: MarketInstallChoices.default({ bots: [], needs: {}, startRoutines: false }),
  }),
  z.strictObject({ op: z.literal("cancel"), id: MarketReviewId }),
  z.strictObject({ op: z.literal("installed") }),
  z.strictObject({ op: z.literal("prepareUpdate"), ...installedKey }),
  z.strictObject({ op: z.literal("remove"), ...installedKey }),
  /** Turns a withdrawn or turned-off entry back on, from its pinned bytes. */
  z.strictObject({ op: z.literal("turnOn"), ...installedKey }),
  /** Spade's view (ADR 0168 §13, `marketplace.spade`): installed market skills with hashes. */
  z.strictObject({ op: z.literal("spadeSkills") }),
  ...marketPublishOperations,
  /** One market skill's files, or one file's content by `path`, as `skills.request files`. */
  z.strictObject({
    op: z.literal("spadeSkillFiles"),
    name: MarketEntryName,
    path: z.string().max(512).optional(),
  }),
]);
export type MarketOperation = z.infer<typeof MarketOperation>;

/** Operations a device with only the read scope may send. */
export const marketReadOperations: readonly MarketOperation["op"][] = [
  "sources",
  "search",
  "home",
  "read",
  "readReview",
  "installed",
  "spadeSkills",
  "spadeSkillFiles",
  "discover",
  "publisher",
];

export const MarketSpadeSkill = z.strictObject({
  name: MarketEntryName,
  version: z.string().max(64),
  /** The pinned content hash: a change means Spade replaces its copy whole. */
  hash: MarketHash,
  description: z.string().max(1024),
});
export type MarketSpadeSkill = z.infer<typeof MarketSpadeSkill>;
export const MarketSpadeFile = z.strictObject({
  path: z.string().min(1).max(512),
  bytes: z.number().int().nonnegative(),
  hash: MarketHash,
  executable: z.boolean(),
});

export const MarketErrorCode = z.enum([
  /** No ace account is signed in on this machine: "Sign in to publish." */
  "signed_out",
  /** The action needs a recent sign-in: "Sign in again to do this." */
  "reauth",
  /** The scan refused it; `scan` says why. */
  "blocked",
  "suspended",
  "quota",
  "not_found",
  "invalid",
  "refused",
  "forbidden",
  "unavailable",
  "conflict",
  "expired",
  "busy",
  "failed",
]);

export const MarketResult = z.discriminatedUnion("op", [
  ...marketPublishResults,
  z.strictObject({ op: z.literal("sources"), sources: z.array(MarketSource).max(32) }),
  z.strictObject({
    op: z.literal("search"),
    entries: z.array(MarketEntrySummary).max(100),
    total: z.number().int().nonnegative(),
    /** The oldest read among the listings searched, so the page can say when it was read. */
    readAt: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    op: z.literal("home"),
    featured: z.array(MarketEntrySummary).max(24),
    categories: z.array(MarketCategory.extend({ entries: z.number().int().nonnegative() })).max(32),
    installed: z.number().int().nonnegative(),
    updates: z.number().int().nonnegative(),
  }),
  z.strictObject({ op: z.literal("read"), entry: MarketEntryDetail }),
  z.strictObject({ op: z.literal("review"), review: MarketReview }),
  z.strictObject({
    op: z.literal("reviewPage"),
    review: MarketReview,
    items: z.array(MarketReviewItem).max(512),
    nextOffset: z.number().int().positive().optional(),
  }),
  z.strictObject({ op: z.literal("installed"), installed: z.array(MarketInstalled).max(1024) }),
  z.strictObject({ op: z.literal("done"), installed: MarketInstalled.optional() }),
  z.strictObject({ op: z.literal("spadeSkills"), skills: z.array(MarketSpadeSkill).max(1024) }),
  z.strictObject({
    op: z.literal("spadeSkillFiles"),
    files: z.array(MarketSpadeFile).max(512),
    /** Base64 of `path`'s bytes, when one was asked for. */
    content: z.string().max(6_000_000).optional(),
  }),
  z.strictObject({
    op: z.literal("error"),
    code: MarketErrorCode,
    message: z.string().max(2000),
    problems: z.array(MarketProblem).max(200).optional(),
    scan: MarketScanReport.optional(),
  }),
]);
export type MarketResult = z.infer<typeof MarketResult>;

export const MarketClientMessage = z.strictObject({
  type: z.literal("marketplace.request"),
  requestId: z.string().min(1).max(80),
  operation: MarketOperation,
});
export type MarketClientMessage = z.infer<typeof MarketClientMessage>;

export const MarketServerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("marketplace.result"),
    requestId: MarketClientMessage.shape.requestId,
    result: MarketResult,
  }),
  /** Pushed to read-scope sockets when installed entries or update counts change. */
  z.strictObject({
    type: z.literal("marketplace.changed"),
    installed: z.number().int().nonnegative(),
    updates: z.number().int().nonnegative(),
  }),
]);
export type MarketServerMessage = z.infer<typeof MarketServerMessage>;
