import { z } from "zod";

/*
 * A replay of a bot's kept runs (ADR 0204 §2) as an update review shows it: Spade's one summary
 * sentence, each run that didn't replay the same with its first reason, and what a replay on one
 * of the person's models would cost before they choose it. Pure.
 */

const count = z.number().int().nonnegative().catch(0);

const ReplayedCase = z.object({
  id: z.string(),
  given: z.string().catch(""),
  passed: z.boolean().catch(false),
  lines: z.array(z.string()).catch([]),
});

/** `{replay}` from `POST /v1/agents/{id}/cases/replay`, or the review's `update.replay`. */
export const SpadeReplay = z.object({
  mode: z.enum(["wiring", "model"]).catch("wiring"),
  model: z.string().optional().catch(undefined),
  cases: z.array(ReplayedCase).max(200).catch([]),
  passed: count,
  failed: count,
  outside: count,
  summary: z.string(),
});
export type SpadeReplay = z.infer<typeof SpadeReplay>;

/** `{estimate}` from `GET /v1/agents/{id}/cases/replay?model=…`. */
export const SpadeReplayEstimate = z.object({
  model: z.string(),
  model_name: z.string().catch(""),
  cases: count,
  cost_micros: count,
  priced: z.boolean().catch(false),
});
export type SpadeReplayEstimate = z.infer<typeof SpadeReplayEstimate>;

/** Reads a replay answer; undefined when it isn't one. */
export function parseSpadeReplay(value: unknown): SpadeReplay | undefined {
  const read = z.object({ replay: SpadeReplay }).safeParse(value);
  return read.success ? read.data.replay : undefined;
}

/** Reads an estimate answer; undefined when it isn't one. */
export function parseSpadeReplayEstimate(value: unknown): SpadeReplayEstimate | undefined {
  const read = z.object({ estimate: SpadeReplayEstimate }).safeParse(value);
  return read.success ? read.data.estimate : undefined;
}

/** Each run that didn't replay the same: what it was given, and the first reason. */
export function replayFailures(
  replay: Pick<SpadeReplay, "cases">,
): { given: string; why: string }[] {
  return replay.cases
    .filter((replayed) => !replayed.passed)
    .map((replayed) => ({
      given: replayed.given || "A kept run",
      why: replayed.lines[0] ?? "It didn't replay the same.",
    }));
}

/** A cost in dollars as the review says it: "about $0.12", "under $0.01", "nothing". */
export function replayDollars(micros: number): string {
  if (micros === 0) return "nothing";
  if (micros < 10_000) return "under $0.01";
  return `about $${(micros / 1e6).toFixed(2)}`;
}

/**
 * The offer of a model replay, in one sentence: "Try it on your last 20 kept runs: about $0.12
 * on Fast." Undefined with no kept runs to try.
 */
export function replayOffer(estimate: SpadeReplayEstimate): string | undefined {
  if (estimate.cases === 0) return undefined;
  const runs =
    estimate.cases === 1 ? "your last kept run" : `your last ${estimate.cases} kept runs`;
  const name = estimate.model_name || estimate.model;
  if (!estimate.priced) return `Try it on ${runs} on ${name}, whose price Spade doesn't know.`;
  const cost = replayDollars(estimate.cost_micros);
  return `Try it on ${runs}: ${cost === "nothing" ? "free" : cost} on ${name}.`;
}
