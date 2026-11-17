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
