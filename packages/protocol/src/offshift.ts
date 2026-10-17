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
  id: key,
  description: text,
  requiredKinds: z.array(OffshiftEvidenceKind).min(1).max(5),
});
const criteria = z
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
  criterionId: key,
  kind: OffshiftEvidenceKind,
  result: z.enum(["pass", "fail"]),
  revision: OffshiftRevision,
  action: text,
  artifact: text,
  note: text,
  recordedAt: Timestamp,
});
const mutation = { runId: key, requestId: key, version: z.number().int().nonnegative() };
export const OffshiftRequest = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    runId: key,
    requestId: key,
    outcome: text,
    endpoint: text,
    criteria,
  }),
  z.strictObject({ action: z.literal("get"), runId: key }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("advance"), ...mutation, phase: OffshiftPhase, note: text }),
  z.strictObject({ action: z.literal("block"), ...mutation, note: text }),
  z.strictObject({ action: z.literal("resume"), ...mutation, note: text }),
  z.strictObject({
    action: z.literal("evidence"),
    ...mutation,
    evidence: OffshiftEvidence.omit({ recordedAt: true }),
  }),
]);
export type OffshiftRequest = z.infer<typeof OffshiftRequest>;
export const OffshiftRun = z.object({
  id: key,
  threadId: ThreadId,
  outcome: text,
  endpoint: text,
  criteria,
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
