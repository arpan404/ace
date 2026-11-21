import { z } from "zod";

/*
 * What Spade measured about a model on this computer (ADR 0205 §3): its three checks (a plain
 * answer, one tool call, a structured answer) and whether ace ran its packages' cases on the
 * model's family. A model that didn't call tools in the check serves titles and summaries only:
 * the picker says why it can't run a bot. Parsed leniently: a field this client can't read reads
 * as nothing said.
 */

export type SpadeCheckResult = "passed" | "failed" | "unreached";

export interface SpadeModelChecks {
  state: "checking" | "checked" | "unchecked";
  plain?: SpadeCheckResult;
  tools?: SpadeCheckResult;
  structured?: SpadeCheckResult;
  /** Spade's line when the checks found it can't run a bot. */
  why?: string;
}

export interface SpadeKnownGood {
  name: string;
  /** The share of ace's cases that passed, 0 to 1. */
  passed: number;
  cases: number;
}

const result = z.enum(["passed", "failed", "unreached"]).nullish().catch(undefined);
const Checks = z.object({
  state: z.enum(["checking", "checked", "unchecked"]),
  plain: result,
  tools: result,
  structured: result,
  why: z.string().max(500).nullish().catch(undefined),
});
const KnownGood = z.object({
  name: z.string().min(1).max(120),
  passed: z.number().min(0).max(1),
  cases: z.number().int().positive(),
});

export function spadeChecksOf(raw: unknown): SpadeModelChecks | undefined {
  const parsed = Checks.safeParse(raw);
  if (!parsed.success) return undefined;
  const { state, plain, tools, structured, why } = parsed.data;
  return {
    state,
    ...(plain ? { plain } : {}),
    ...(tools ? { tools } : {}),
    ...(structured ? { structured } : {}),
    ...(why ? { why } : {}),
  };
}

export function spadeKnownGoodOf(raw: unknown): SpadeKnownGood | undefined {
  const parsed = KnownGood.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The words for a model ace measured: "Works well with Spade's packages". */
export const spadeWorksWell = "Works well with Spade's packages";

/**
 * What Settings says under a local model: its checks running, what they found, or that ace's
 * cases ran well on its family. Undefined when there is nothing to say.
 */
export function spadeChecksLine(model: {
  checks?: SpadeModelChecks | undefined;
  knownGood?: SpadeKnownGood | undefined;
}): string | undefined {
  const checks = model.checks;
  if (checks?.state === "checking") return spadeChecking;
  if (checks?.state === "checked" && checks.why) return checks.why;
  if (model.knownGood) return spadeWorksWell;
  if (checks?.state === "checked") return "Passed Spade's checks";
  return undefined;
}

/** A picker row's few words for a model whose checks found it can't call tools. */
export const spadeNoToolsShort = "Didn't call tools · titles and summaries only";

/** What the picker says while a model's checks run. */
export const spadeChecking = "Checking what it can do…";

/**
 * Why a model can't run a bot now, if it can't: its checks found it doesn't call tools (Spade's
 * own words), they couldn't reach it, or they are still running. Undefined for every other model.
 */
export function spadeCantRunBots(model: {
  checks?: SpadeModelChecks | undefined;
}): string | undefined {
  const checks = model.checks;
  if (!checks) return undefined;
  if (checks.state === "checking") return spadeChecking;
  return checks.state === "checked" ? checks.why : undefined;
}
