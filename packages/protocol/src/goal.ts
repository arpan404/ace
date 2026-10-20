import { z } from "zod";
import { Timestamp } from "./ids.ts";

/**
 * Where a provider-native goal stands. `active` keeps the agent starting turns by itself until it
 * judges the goal met; the rest say why it stopped.
 */
export const ProviderGoalStatus = z.enum([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);
export type ProviderGoalStatus = z.infer<typeof ProviderGoalStatus>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * A goal the thread's provider keeps working toward across turns (Codex `/goal`, Claude `/goal`).
 * The provider owns it; ace mirrors its latest state on the thread.
 */
export const ProviderGoal = z.object({
  /** What "done" means, in the words it was set with. */
  objective: z.string().min(1).max(4000),
  status: ProviderGoalStatus,
  tokensUsed: count.optional(),
  tokenBudget: count.optional(),
  timeUsedSeconds: count.optional(),
  /** How many times the provider has checked whether the goal is met. */
  checks: count.optional(),
  /** The provider's latest reason the goal isn't met yet. */
  lastReason: z.string().max(4000).optional(),
  setAt: Timestamp.optional(),
});
export type ProviderGoal = z.infer<typeof ProviderGoal>;

/** The person's change to a native goal: a new objective, or pausing and resuming it. */
export const GoalChange = z.union([
  z.object({ objective: z.string().max(4000).regex(/\S/) }),
  z.object({ status: z.enum(["active", "paused"]) }),
]);
export type GoalChange = z.infer<typeof GoalChange>;
