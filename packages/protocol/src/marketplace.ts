import { z } from "zod";
import { PluginExecution, PluginHash, PluginName } from "./plugins.ts";

/*
 * ace's marketplace on the wire (ADR 0168): the entry model both sources produce, the review a
 * `prepare` returns, and the `marketplace.request` / `marketplace.result` envelopes beside
 * ADR 0014's plugin ones. Schema only; parsing, ranking and verification live in
 * `@ace/marketplace`.
 */

/** The entry types this build knows. Others are kept as their raw string and never installed. */
export const MarketEntryType = z.enum([
  "suit",
  "spade-skill",
  "spade-plugin",
  "spade-bot",
  "ace-plugin",
]);
export type MarketEntryType = z.infer<typeof MarketEntryType>;
/** The types this build installs; `ace-plugin` waits for its own ADR (phase 3). */
export const installableMarketTypes: readonly MarketEntryType[] = [
  "suit",
  "spade-skill",
  "spade-plugin",
  "spade-bot",
];

/** An entry's name within its type: the same rule as a plugin name. */
export const MarketEntryName = PluginName;
/** A published version: dotted numbers with an optional pre-release tag. */
export const MarketVersion = z
  .string()
  .max(64)
  .regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/);
export type MarketVersion = z.infer<typeof MarketVersion>;
/** ADR 0014's content hash: sha256 over sorted paths, sizes, executable bits and file hashes. */
export const MarketHash = PluginHash;
/** `market` is market.acehq.dev; a git catalog is `git:` and a short id the daemon gave it. */
export const MarketSourceId = z.string().regex(/^(?:market|git:[a-z0-9]{1,32})$/);
export type MarketSourceId = z.infer<typeof MarketSourceId>;
export const MarketCategoryId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
export const MarketPublisherName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/)
  .refine((value) => !value.includes("--"));
export const MarketPublisher = z.strictObject({
  id: z.string().min(1).max(64),
  name: MarketPublisherName,
});
export type MarketPublisher = z.infer<typeof MarketPublisher>;

const line = z.string().max(300);
const words = z.string().max(8192);

/** One entry as a list row shows it. `type` is any string; `supported` says this build knows it. */
export const MarketEntrySummary = z.strictObject({
  source: MarketSourceId,
  type: z.string().min(1).max(40),
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  line: line,
  publisher: MarketPublisher.optional(),
  categories: z.array(MarketCategoryId).max(3),
  keywords: z.array(z.string().min(1).max(40)).max(16),
  version: MarketVersion.optional(),
  /** ace's maintainers read it, by the signer's word (a signed review mark). */
  reviewed: z.boolean(),
  /** Published by ace itself. */
  byAce: z.boolean(),
  updated: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  supported: z.boolean(),
  /** A git catalog's address, shown as "From <address>". */
  from: z.string().max(2048).optional(),
});
export type MarketEntrySummary = z.infer<typeof MarketEntrySummary>;

export const MarketCategory = z.strictObject({
  id: MarketCategoryId,
  title: z.string().min(1).max(60),
});
export type MarketCategory = z.infer<typeof MarketCategory>;

export const MarketEntryVersion = z.strictObject({
  version: MarketVersion,
  hash: MarketHash,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  withdrawn: z.string().max(500).optional(),
});
export type MarketEntryVersion = z.infer<typeof MarketEntryVersion>;

/** What turned an installed entry off. A withdrawn entry stays off until the person turns it on. */
export const MarketInstallState = z.enum(["on", "withdrawn", "off"]);
export const MarketInstalled = z.strictObject({
  source: MarketSourceId,
  type: MarketEntryType,
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  version: z.string().max(64),
  hash: MarketHash,
  acceptedAt: z.number().int().nonnegative(),
  state: MarketInstallState,
  /** The signed withdrawal's reason, when `state` is `withdrawn`. */
  reason: z.string().max(500).optional(),
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

export const MarketProblem = z.strictObject({
  path: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().max(500),
});
export type MarketProblem = z.infer<typeof MarketProblem>;

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
