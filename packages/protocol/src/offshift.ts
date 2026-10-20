import { z } from "zod";
import { ThreadId, Timestamp } from "./ids.ts";

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const text = z.string().min(1).max(4096);
export const OffshiftEvidenceKind = z.enum(["automated", "source", "ui", "human", "manual"]);
export const OffshiftPhase = z.enum(["plan", "implement", "verify", "review", "delivery"]);
export const OffshiftCriterion = z.strictObject({
  id: key.describe("A stable id for the criterion (letters, digits, _ . -)."),
  description: text.describe("The observable behaviour that must hold."),
  requiredKinds: z
    .array(OffshiftEvidenceKind)
    .min(1)
    .max(5)
    .describe("Evidence kinds that must each have a current pass."),
});
export type OffshiftCriterion = z.infer<typeof OffshiftCriterion>;
/** A run holds at most 64 criteria, each id once. */
export const OffshiftCriteria = z
  .array(OffshiftCriterion)
  .min(1)
  .max(64)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Criterion IDs must be unique",
  )
  .meta({ "x-ace-constraint": "Criterion IDs must be unique." });
export const OffshiftRevision = z.string().min(1).max(512);
export const OffshiftEvidence = z.strictObject({
  criterionId: key.describe("The criterion this observation checks."),
  kind: OffshiftEvidenceKind.describe("Which required kind this observation satisfies."),
  result: z.enum(["pass", "fail"]).describe("What the check observed."),
  revision: OffshiftRevision.describe("The revision from get, read before the check ran."),
  action: text.describe("The command or interaction actually performed."),
  artifact: text.describe("Where the full output is kept: a path, URL or report reference."),
  note: text.describe("The observed result and environment, in a sentence or two."),
  recordedAt: Timestamp,
});
export const OffshiftEvidenceInput = OffshiftEvidence.omit({ recordedAt: true });
const mutation = { runId: key, requestId: key, version: z.number().int().nonnegative() };
export const OffshiftRequest = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    runId: key,
    requestId: key,
    outcome: text,
    endpoint: text,
    criteria: OffshiftCriteria,
  }),
  z.strictObject({ action: z.literal("get"), runId: key }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("advance"), ...mutation, phase: OffshiftPhase, note: text }),
  z.strictObject({ action: z.literal("block"), ...mutation, note: text }),
  z.strictObject({ action: z.literal("resume"), ...mutation, note: text }),
  z.strictObject({ action: z.literal("evidence"), ...mutation, evidence: OffshiftEvidenceInput }),
  /** Adds a criterion, or replaces the one with its id and drops that criterion's evidence. */
  z.strictObject({
    action: z.literal("revise"),
    ...mutation,
    criterion: OffshiftCriterion,
    note: text,
  }),
]);
export type OffshiftRequest = z.infer<typeof OffshiftRequest>;
export const OffshiftRun = z.object({
  id: key,
  threadId: ThreadId,
  outcome: text,
  endpoint: text,
  criteria: OffshiftCriteria,
  phase: OffshiftPhase,
  version: z.number().int().nonnegative(),
  blocker: text.nullable(),
  note: text,
  evidence: z.array(OffshiftEvidence).max(320),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type OffshiftRun = z.infer<typeof OffshiftRun>;
export const OffshiftView = z.object({
  run: OffshiftRun,
  revision: OffshiftRevision,
  state: z.enum(["active", "blocked", "needs_evidence", "waiting_on_tree", "complete"]),
  pending: z.array(z.object({ criterionId: key, kind: OffshiftEvidenceKind })).max(320),
  treeState: z.enum(["working", "waiting", "needs_you", "failed", "done", "unknown"]),
});
export type OffshiftView = z.infer<typeof OffshiftView>;
/** One line of `list`: metadata only, so evidence bodies never multiply the result size. */
export const OffshiftRunSummary = z.object({
  id: key,
  phase: OffshiftPhase,
  outcome: z.string().max(512),
  outcomeTruncated: z.boolean(),
});
export type OffshiftRunSummary = z.infer<typeof OffshiftRunSummary>;
/** What `offshift` returns: a run's view, or the caller's run summaries for `list`. */
export const OffshiftResult = z.union([OffshiftView, z.array(OffshiftRunSummary).max(32)]);
export type OffshiftResult = z.infer<typeof OffshiftResult>;
