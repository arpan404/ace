import { z } from "zod";
import { ThreadId } from "./ids.ts";
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
import { SpadePersonality } from "./marketplace-catalog.ts";
import {
  PackageCodeImport,
  PackageEffectWord,
  PackageGrant,
  PackageLimits,
  PackagePlan,
  PackageTrigger,
} from "./marketplace-package.ts";
import { MarketScanReport } from "./marketplace-scan.ts";
import { MarketKeyId, MarketOrgId } from "./marketplace-signed.ts";

export * from "./marketplace-base.ts";
export * from "./marketplace-publish-pick.ts";
export * from "./marketplace-catalog.ts";
export * from "./marketplace-package.ts";
export * from "./marketplace-discover.ts";
export * from "./marketplace-publish-ops.ts";
export * from "./marketplace-publisher.ts";
export * from "./marketplace-scan.ts";
export * from "./marketplace-service.ts";
export * from "./marketplace-signed.ts";
export * from "./marketplace-registry.ts";

/*
 * ace's marketplace on the wire (ADR 0168): the entry model both sources produce, the review a
 * `prepare` returns, and the `marketplace.request` / `marketplace.result` envelopes beside
 * ADR 0014's plugin ones. Schema only; parsing, ranking and verification live in
 * `@ace/marketplace`.
 */

const words = z.string().max(8192);

/** What turned an installed entry off. A withdrawn entry stays off until the person turns it on. */
/** `blocked`: its bytes match the signed blocklist (ADR 0174 §8); off until removed. */
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
  /**
   * For a Spade skill: whether the person turned this installed version on for their bots (ADR
   * 0178 §12.8). False after an install or update by a caller without the person's standing:
   * the skill is installed but no bot sees it until the person turns it on.
   */
  botsApproved: z.boolean().optional(),
  /** A bot from a version 3 package: it stays linked, so it updates and rolls back (ADR 0200). */
  linked: z.boolean().optional(),
  /** The version a linked bot had before, kept pinned here so a rollback needs no network. */
  previous: z.strictObject({ version: z.string().max(64), hash: MarketHash }).optional(),
  /**
   * An update of a linked bot the person accepted while it worked: Spade applies it when the
   * bot's turn ends. `version` above stays the one running until then.
   */
  held: z.strictObject({ version: z.string().max(64) }).optional(),
  /** From this organization's private registry (ADR 0206 §5.4), not the public market. */
  registry: MarketOrgId.optional(),
  /**
   * Why its updates stopped, as a sentence: the account here is no longer a member of the
   * registry's organization. It stays installed and on; nothing was deleted.
   */
  updatesStopped: z.string().max(300).optional(),
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

/** One effect a package declares, as a switch on its review (ADR 0200 §3.4). */
export const MarketEffectRow = z.strictObject({
  /** The switch's key, as Spade reads it (`network:hosts:api.example.com`). */
  key: z.string().min(1).max(2100),
  effect: PackageEffectWord,
  hosts: z.array(z.string().max(260)).max(32).optional(),
  grant: PackageGrant.optional(),
  why: z.string().max(500),
});
export type MarketEffectRow = z.infer<typeof MarketEffectRow>;

/** The free replay of the bot's kept runs on the version a review would move it to (ADR 0204 §2). */
export const MarketBotReplay = z.object({
  /** Spade's sentence: "18 of 20 kept runs replay the same. 2 don't: see why." */
  summary: z.string().max(500),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cases: z
    .array(
      z.object({
        id: z.string().max(80),
        given: z.string().max(300),
        passed: z.boolean(),
        lines: z.array(z.string().max(2000)).max(20),
      }),
    )
    .max(200),
});
export type MarketBotReplay = z.infer<typeof MarketBotReplay>;

/**
 * One WebAssembly component a package ships, as a row on its review (ADR 0203 §5): "Runs its own
 * code: fares. It can call Spade's tools as this bot." Its imports are the binary's: the signer
 * read them from the bytes and refused a version whose manifest said otherwise.
 */
export const MarketCodeRow = z.strictObject({
  name: z.string().min(1).max(24),
  imports: z.array(PackageCodeImport).max(7),
  why: z.string().max(500),
  sentence: z.string().max(2000),
});
export type MarketCodeRow = z.infer<typeof MarketCodeRow>;

/** What an update or rollback of a linked bot does, for its review (ADR 0200 §6.1). */
export const MarketBotUpdate = z.strictObject({
  bot: z.string().min(1).max(80),
  /** Back to the version it had before, from the bytes pinned here. */
  rollback: z.boolean(),
  /** Spade's plan: what is replaced, and what stays because the person or the bot changed it. */
  plan: PackagePlan,
  /** What the new version asks for that the old one didn't, besides effects; it starts off. */
  asksMore: z.array(z.string().max(500)).max(64),
  /** Its kept runs replayed free on the new version; absent with none, or when Spade couldn't. */
  replay: MarketBotReplay.optional(),
});
export type MarketBotUpdate = z.infer<typeof MarketBotUpdate>;

/** What one type can do, in the facts its review page says in sentences. */
const MarketReviewBodySchema = z.discriminatedUnion("type", [
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
    /** SKILL.md's `license`, shown as it says (ADR 0202 §1). */
    license: z.string().max(200).optional(),
    /** `compatibility`, shown; never a reason to refuse. */
    compatibility: z.string().max(500).optional(),
    /** `allowed-tools`: what the skill asks to run without asking. It grants nothing. */
    allowedTools: z.array(z.string().max(120)).max(64).optional(),
    /** Front matter fields this ace keeps but doesn't use. */
    unused: z.array(z.string().max(120)).max(64).optional(),
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
    personality: SpadePersonality.optional(),
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
    /** A version 3 package: the bot stays linked to it (ADR 0200 §3.9). */
    linked: z.boolean().optional(),
    /** Its declared effects, each a switch the person sets; nothing is granted before Install. */
    effects: z.array(MarketEffectRow).max(32).optional(),
    /** Its own code, a row per component; every version with code was read by a maintainer. */
    code: z.array(MarketCodeRow).max(4).optional(),
    /** Its triggers other than schedules, which `routines` lists. */
    triggers: z.array(PackageTrigger).max(40).optional(),
    limits: PackageLimits.optional(),
    /** Fields this build doesn't use: "Not used by this Spade". */
    unused: z.array(z.string().max(80)).max(64).optional(),
    /** For an update or a rollback of an installed bot. */
    update: MarketBotUpdate.optional(),
    /**
     * It uses apps or agents, which take a model that calls tools, and none of the models it
     * would think with does (ADR 0205 §3). Installing still works; the bot can't act until then.
     */
    modelWarning: z.string().max(500).optional(),
  }),
]);
export type MarketReviewBody = z.infer<typeof MarketReviewBodySchema>;
/** Typed by name, so the wire's unions that carry a review stay small enough to declare. */
export const MarketReviewBody: z.ZodType<MarketReviewBody> = MarketReviewBodySchema;

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
  /** The device's own scan of these bytes (ADR 0174 §8): every finding, as sentences. */
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
  /** A package's effect switches as the person left them, by `MarketEffectRow.key`; one missing is off. */
  effects: z.record(z.string().max(2100), z.boolean()).optional(),
});
export type MarketInstallChoices = z.infer<typeof MarketInstallChoices>;

/* ---------------------------------------------------------------- operations */

const entryKey = { source: MarketSourceId, type: z.string().min(1).max(40), name: MarketEntryName };
const installedKey = {
  type: MarketEntryType,
  name: MarketEntryName,
  /** For a bot package, which bot made from it (ADR 0200 §3.9): one package can make several. */
  bot: z.string().min(1).max(80).optional(),
};

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
  z.strictObject({
    op: z.literal("prepare"),
    ...entryKey,
    version: MarketVersion.optional(),
    /**
     * An entry of this organization's private registry (ADR 0206 §5.4), read with the message's
     * `orgGrant`. Only the market source has registries.
     */
    registry: MarketOrgId.optional(),
    /**
     * The person trusts the registry's key chain starting at this key on this machine (ADR 0206
     * §5.3): their answer to `registry_trust`. Needed once per chain.
     */
    trustKey: MarketKeyId.optional(),
  }),
  /**
   * Reads which installed entries of an organization's registry have newer versions, with the
   * message's `orgGrant`; a valid one also resumes updates stopped earlier.
   */
  z.strictObject({ op: z.literal("registryRefresh"), registry: MarketOrgId }),
  /**
   * The account here is no longer a member of the organization: its registry's installs stop
   * updating and stay as they are (ADR 0206 §5.4). It only narrows, so any client may say it.
   */
  z.strictObject({ op: z.literal("registryLeft"), registry: MarketOrgId }),
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
  /** A review of the version a linked bot had before, from the bytes pinned here (ADR 0200). */
  z.strictObject({ op: z.literal("prepareRollback"), ...installedKey }),
  z.strictObject({ op: z.literal("remove"), ...installedKey }),
  /** Turns a withdrawn or turned-off entry back on, from its pinned bytes. */
  z.strictObject({ op: z.literal("turnOn"), ...installedKey }),
  /**
   * The person turns an installed Spade skill on for their bots: exactly the version with this
   * `hash`, so an update installed since needs turning on again (ADR 0178 §12.8). Person-only.
   */
  z.strictObject({ op: z.literal("turnOnForBots"), name: MarketEntryName, hash: MarketHash }),
  /** Spade's view (ADR 0168 §13, `marketplace.spade`): installed market skills with hashes. */
  z.strictObject({ op: z.literal("spadeSkills") }),
  /**
   * The version of a bot package the market lists now, for a bot's suggestion (ADR 0200 §8):
   * its signed version manifest and `bot.json`. Spade checks the signature itself.
   */
  z.strictObject({ op: z.literal("spadeBot"), name: MarketEntryName }),
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
  "spadeBot",
  "discover",
  "publisher",
  "picture",
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
  /**
   * An agent asked for an action that is the person's (ADR 0178 §12.5): ace opened a request in
   * the asking thread's strip, named by `request`, that only a person's device answers.
   */
  "person_only",
  /**
   * A sensitive action the market takes only with a grant from the person's own session naming
   * this request (ADR 0190): the client asks for one with `action` and sends the request again
   * with it as `personGrant`.
   */
  "person_grant",
  /**
   * An organization's registry needs a fresh proof of membership (ADR 0206 §5.3): the client
   * sends the request again with an `orgGrant` for that organization, or the account isn't a
   * member.
   */
  "not_member",
  /**
   * The device hasn't trusted this registry's key chain yet, or its first key was reset: the
   * person answers with `trustKey`. `registryKey` names the key.
   */
  "registry_trust",
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
    op: z.literal("spadeBot"),
    /** The market's signed version manifest, as served; checked by Spade, not here. */
    signed: z.unknown(),
    /** `bot.json` exactly as the signed archive has it. */
    botJson: z.string().max(1_000_000),
    /** Its contracts' schema files (`contracts/<name>.json`), by path, as the archive has them. */
    contractFiles: z.record(z.string().max(80), z.string().max(40_960)).optional(),
  }),
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
    /** The person's request ace opened, for `person_only`. */
    request: z.string().max(200).optional(),
    /** For `person_grant`: the market request, `METHOD /path`, a person's grant must name. */
    action: z.string().min(1).max(512).optional(),
    /** For `registry_trust`: the first key of the chain to trust, who added it and when. */
    registryKey: z
      .strictObject({
        org: MarketOrgId,
        key: MarketKeyId,
        addedBy: z.string().max(128),
        at: z.number().int().nonnegative(),
        /** A device that trusted another first key before: the chain was reset. */
        reset: z.boolean(),
      })
      .optional(),
  }),
]);
export type MarketResult = z.infer<typeof MarketResult>;

export const MarketClientMessage = z.strictObject({
  type: z.literal("marketplace.request"),
  requestId: z.string().min(1).max(80),
  operation: MarketOperation,
  /**
   * The thread of the agent asking (`ACE_THREAD_ID` in its shell, ADR 0178 §10): the daemon
   * turns a person-only action into a request in that thread instead of running it.
   */
  thread: ThreadId.optional(),
  /**
   * A market grant the client got with the person's own session for this request's one market
   * call (ADR 0190): the market takes a sensitive action only with it. Never a machine's.
   */
  personGrant: z.string().min(1).max(4096).optional(),
  /**
   * A market grant acting in an organization (`org` claim), which the client got with the
   * person's own session after the account backend's fresh membership check (ADR 0206 §5.3). The
   * daemon reads that organization's registry with it, and installs from it only with it.
   */
  orgGrant: z.string().min(1).max(4096).optional(),
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
