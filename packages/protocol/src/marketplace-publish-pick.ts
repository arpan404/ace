import { z } from "zod";
import { MarketEntryName } from "./marketplace-base.ts";
import { Recipe } from "./marketplace-catalog.ts";
import { PluginName } from "./plugins.ts";
import { SkillId } from "./skill-library.ts";

/*
 * The publish flow's picker (ADR 0174 §2): the person's own bots, skills and plugins that can be
 * published, each with the source the daemon reads its files from, and a bot's recipe as it will
 * be published. Clients name things by id, never by path; the daemon finds the folder. Schema only.
 */

/** Spade's id for a bot or a skill in its store. */
const SpadeId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

/** The picker's sources: the daemon reads the files for each, so a draft never names a path. */
export const marketPickedSources = [
  /** One of the person's Spade bots, exported as a version 2 recipe (`bot.json`). */
  z.strictObject({ kind: z.literal("spade-bot"), id: SpadeId }),
  /** A skill written in Spade, from Spade's skill store (ADR 0151). */
  z.strictObject({ kind: z.literal("spade-skill"), id: SpadeId }),
  /** A personal skill in ace's skill library (ADR 0103). */
  z.strictObject({ kind: z.literal("ace-skill"), id: SkillId }),
  /** An installed plugin the person made, from its local folder. */
  z.strictObject({ kind: z.literal("plugin"), name: PluginName }),
] as const;

/** What can be picked to publish. */
export const MarketPickType = z.enum(["spade-bot", "spade-skill", "spade-plugin"]);
export type MarketPickType = z.infer<typeof MarketPickType>;

/** One of the person's own things they could publish. */
export const MarketPublishable = z.strictObject({
  type: MarketPickType,
  /** The name it would take in the marketplace, made from its own name. */
  name: MarketEntryName,
  title: z.string().min(1).max(120),
  /** A bot's task, a skill's description or a plugin's version, as one line. */
  line: z.string().max(300),
  /** Where it lives: a Spade bot or skill, ace's skill library, or an installed plugin. */
  from: z.enum(["spade", "ace", "plugin"]),
  /** A bot's face, as Spade stores it. */
  face: z.record(z.string().max(40), z.unknown()).optional(),
  source: z.discriminatedUnion("kind", marketPickedSources),
});
export type MarketPublishable = z.infer<typeof MarketPublishable>;

export const marketPickOperations = [
  /** The person's own things of a type that can be published. */
  z.strictObject({ op: z.literal("publishables"), type: MarketPickType }),
  /** A bot's recipe as publishing it would send it. */
  z.strictObject({ op: z.literal("botRecipe"), id: SpadeId }),
] as const;

export const marketPickResults = [
  z.strictObject({
    op: z.literal("publishables"),
    items: z.array(MarketPublishable).max(1000),
    /** Places that couldn't be read just now, as sentences ("Spade isn't running."). */
    unavailable: z.array(z.string().max(300)).max(8),
  }),
  z.strictObject({
    op: z.literal("botRecipe"),
    recipe: Recipe,
    /** What of the bot a recipe can't carry, one sentence each. */
    leftOut: z.array(z.string().max(500)).max(20),
  }),
] as const;

/* ---------------------------------------------------------------- checks before upload */

/** What the privacy pass flags (ADR 0174 §2); `secret` is never confirmable. */
export const MarketPrivacyKind = z.enum([
  "secret",
  "home-path",
  "email",
  "phone",
  "private-url",
  "own-name",
]);
export type MarketPrivacyKind = z.infer<typeof MarketPrivacyKind>;
export const MarketPrivacySpan = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  kind: MarketPrivacyKind,
  text: z.string().max(2000),
});
export type MarketPrivacySpan = z.infer<typeof MarketPrivacySpan>;

/** One file that would upload. A binary file uploads only when the person ticks it. */
export const MarketDraftFile = z.strictObject({
  path: z.string().min(1).max(512),
  bytes: z.number().int().nonnegative(),
  binary: z.boolean(),
});
/** A file left home before it was read: hidden, or named like a credential. */
export const MarketDraftLeftOut = z.strictObject({
  path: z.string().min(1).max(512),
  reason: z.enum(["hidden", "credential"]),
});
/** Something a check found in a file. A blocking one must be fixed; the rest confirmed. */
export const MarketDraftFinding = z.strictObject({
  path: z.string().max(512),
  line: z.number().int().positive().optional(),
  kind: z.union([MarketPrivacyKind, z.literal("hidden-text")]),
  /** The flagged text, which the person confirms by sending it back; empty for a blocking one. */
  text: z.string().max(2000),
  sentence: z.string().max(500),
  blocking: z.boolean(),
});
export type MarketDraftFinding = z.infer<typeof MarketDraftFinding>;

/** A bot's recipe as it would publish, with the privacy pass over its words. */
export const MarketBotReview = z.strictObject({
  recipe: Recipe,
  leftOut: z.array(z.string().max(500)).max(20),
  name: z.array(MarketPrivacySpan).max(100),
  task: z.array(MarketPrivacySpan).max(200),
  /** By routine, in the recipe's order: spans in its name and in its instruction. */
  routines: z
    .array(
      z.strictObject({
        name: z.array(MarketPrivacySpan).max(20),
        instruction: z.array(MarketPrivacySpan).max(100),
      }),
    )
    .max(32),
});
export type MarketBotReview = z.infer<typeof MarketBotReview>;

/** What publishing would upload, checked on this machine before anything leaves it. */
export const MarketDraftCheck = z.strictObject({
  files: z.array(MarketDraftFile).max(1024),
  excluded: z.array(MarketDraftLeftOut).max(1024),
  findings: z.array(MarketDraftFinding).max(500),
  /** Taken now over what was read; the draft is refused if the source changed since. */
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  bot: MarketBotReview.optional(),
});
export type MarketDraftCheck = z.infer<typeof MarketDraftCheck>;

const RecipeRoutineText = z.strictObject({
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
  schedule: z.string().trim().min(1).max(200),
});

/** The person's confirmation of a check, sent with the draft. */
export const MarketDraftChecked = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** The binary files the person ticked. */
  binaries: z.array(z.string().max(512)).max(1024),
  /** Each flagged text the person saw and confirmed may be public. */
  accepted: z.array(z.string().max(2000)).max(500),
  /** A bot's task as the person edited or confirmed it, and the routines they included. */
  recipe: z
    .strictObject({
      task: z.string().max(4000),
      routines: z.array(RecipeRoutineText).max(32),
    })
    .optional(),
});
export type MarketDraftChecked = z.infer<typeof MarketDraftChecked>;

export const marketPrivacyOperations = [
  /** The privacy pass over text the person edited, in the order sent. */
  z.strictObject({
    op: z.literal("privacyCheck"),
    texts: z.array(z.string().max(8000)).max(40),
  }),
] as const;
export const marketPrivacyResults = [
  z.strictObject({
    op: z.literal("privacyCheck"),
    spans: z.array(z.array(MarketPrivacySpan).max(200)).max(40),
  }),
] as const;
