import { z } from "zod";
import { CliProblem } from "./cli-output.ts";

/*
 * What `ace bot init|check|test|dev` print with `--json` (ADR 0200 §9, ADR 0178 §3). Schema
 * only; `ace bot publish` answers with the market's own `MarketPublishAnswer`.
 */

/** The starting points `ace bot init --template` offers. */
export const CliBotStarter = z.enum(["blank", "watcher", "club-member"]);
export type CliBotStarter = z.infer<typeof CliBotStarter>;

/**
 * `ace bot init`: the folder made and every file written in it; the template it started from, or
 * with `--from`, the bot's id and what of the bot a package couldn't carry.
 */
export const CliBotInit = z.object({
  path: z.string(),
  name: z.string(),
  template: CliBotStarter.optional(),
  from: z.string().optional(),
  files: z.array(z.string()),
  left_out: z.array(z.string()).optional(),
});
export type CliBotInit = z.infer<typeof CliBotInit>;

/** `ace bot check`: the market's checks passed; warnings are worth fixing, never refusals. */
export const CliBotCheck = z.object({
  name: z.string(),
  hash: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  warnings: z.array(CliProblem),
});
export type CliBotCheck = z.infer<typeof CliBotCheck>;

/** One call a scenario's run made, as Spade's gate read it. */
export const CliBotCall = z.object({
  tool: z.string(),
  effect: z.string().nullable().optional(),
  outcome: z.union([
    z.literal("ran"),
    z.object({ refused: z.string() }),
    z.object({ failed: z.string() }),
  ]),
});

export const CliBotScenario = z.object({
  file: z.string(),
  name: z.string(),
  passed: z.boolean(),
  failures: z.array(z.string()),
  calls: z.array(CliBotCall),
});
export type CliBotScenario = z.infer<typeof CliBotScenario>;

/** One kept run replayed (ADR 0204 §2): what it was given, and why it didn't replay the same. */
export const CliBotReplayCase = z.object({
  id: z.string(),
  given: z.string(),
  mark: z.enum(["right", "wrong"]).optional(),
  passed: z.boolean(),
  lines: z.array(z.string()),
  /** Calls outside the recording, answered "Not in the recording". */
  outside: z.number().int().nonnegative(),
});
export type CliBotReplayCase = z.infer<typeof CliBotReplayCase>;

/** `ace bot test --cases`: a bot's kept runs replayed, free on the recorded steps or on a model. */
export const CliBotReplay = z.object({
  mode: z.enum(["wiring", "model"]),
  model: z.string().optional(),
  cases: z.array(CliBotReplayCase),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outside: z.number().int().nonnegative(),
  summary: z.string(),
});
export type CliBotReplay = z.infer<typeof CliBotReplay>;

/**
 * `ace bot test`: each scenario on Spade's engine with the scripted model (`spade --bot-test`);
 * with `--cases`, a bot's kept runs replayed instead (`replay`, and no scenarios).
 */
export const CliBotTest = z.object({
  name: z.string().nullable(),
  passed: z.boolean(),
  problems: z.array(z.string()),
  scenarios: z.array(CliBotScenario),
  replay: CliBotReplay.optional(),
});
export type CliBotTest = z.infer<typeof CliBotTest>;

/** `ace bot dev`: one step on the development bot, printed as it happens. */
export const CliBotDev = z.object({
  step: z.enum(["installed", "updated", "unchanged", "waiting", "refused"]),
  bot: z.string(),
  name: z.string(),
  /** The folder's content hash, as `ace bot check` prints it. */
  hash: z.string(),
  /** Why a save wasn't applied: its check's problems, or the bot was busy. */
  why: z.array(z.string()).optional(),
});
export type CliBotDev = z.infer<typeof CliBotDev>;

export const cliBotOutputs = {
  "bot.init": CliBotInit,
  "bot.check": CliBotCheck,
  "bot.test": CliBotTest,
  "bot.dev": CliBotDev,
} satisfies Record<string, z.ZodType>;
