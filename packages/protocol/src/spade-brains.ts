import { z } from "zod";
import { ProviderKind } from "./provider-data.ts";

/**
 * Spade's bots thinking with the person's subscriptions (ADR 0133): what Spade sends the daemon
 * over its grant and what comes back. `spade/docs/cli-brains.md` is the contract.
 */

/** A Spade agent id, as Spade makes them. */
export const SpadeBotId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

/** `POST /spade/brains/turn`: one turn of a bot's hidden provider session. */
export const SpadeBrainTurnRequest = z.strictObject({
  bot: SpadeBotId,
  provider: ProviderKind,
  /** ace's account id; the provider's default account when absent. */
  account: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256),
  /** Spade's rules, the bot's task and its indexes; sent when the session is new or they changed. */
  instructions: z.string().max(256 * 1024),
  instructionsChanged: z.boolean().default(false),
  /** What arrived since the bot's last turn, rendered by Spade. */
  message: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
export type SpadeBrainTurnRequest = z.infer<typeof SpadeBrainTurnRequest>;

/** Why a turn on a subscription failed. Each is shown as one line; none is retried. */
export const SpadeBrainFailure = z.enum([
  "not_installed",
  "signed_out",
  "rate_limited",
  "quota",
  "needs_permission",
  "unavailable",
  "failed",
]);
export type SpadeBrainFailure = z.infer<typeof SpadeBrainFailure>;

/** One JSON line of a turn's answer; the last is `finished` or `failed`. */
export const SpadeBrainFrame = z.discriminatedUnion("type", [
  /** The bot's hidden thread; `fresh` when this turn started its session. */
  z.object({ type: z.literal("session"), thread: z.string(), fresh: z.boolean() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  /**
   * The CLI read something from outside with its own tools (the web, another program's output):
   * Spade treats the rest of the turn as untrusted. Sent once per source.
   */
  z.object({ type: z.literal("read"), source: z.string().max(200) }),
  /** A few plain words on what the CLI is doing; null when it is thinking. */
  z.object({ type: z.literal("status"), status: z.string().max(200).nullable() }),
  z.object({
    type: z.literal("finished"),
    usage: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }),
  }),
  z.object({ type: z.literal("failed"), reason: SpadeBrainFailure, message: z.string().max(500) }),
]);
export type SpadeBrainFrame = z.infer<typeof SpadeBrainFrame>;

/** `GET /spade/brains/subscriptions`: what a bot can think with, only installed and signed in. */
export const SpadeSubscription = z.object({
  provider: ProviderKind,
  /** The provider's name as people know it. */
  name: z.string(),
  accounts: z.array(z.object({ id: z.string(), label: z.string().nullable() })).max(64),
  models: z.array(z.object({ id: z.string(), name: z.string() })).max(256),
});
export type SpadeSubscription = z.infer<typeof SpadeSubscription>;
export const SpadeSubscriptions = z.object({ providers: z.array(SpadeSubscription).max(16) });
export type SpadeSubscriptions = z.infer<typeof SpadeSubscriptions>;

/** `spade_call`, the bot's own tools as ace forwards them to Spade. */
export const SpadeToolCallInput = z.strictObject({
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
