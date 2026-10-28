import { z } from "zod";
import { ThreadId } from "./ids.ts";
import {
  OffshiftCriteria,
  OffshiftCriterion,
  OffshiftEvidenceKind,
  OffshiftPhase,
  OffshiftPlaybookId,
  OffshiftRevision,
  OffshiftView,
} from "./offshift.ts";

/*
 * The person's own controls on a thread's Offshift runs (ADR 0090, "The person"). Each change
 * names the run version it was made against, so an agent write in between is refused rather
 * than overwritten, and the person's changes are recorded as the person's, never the agent's.
 */

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const text = z.string().min(1).max(4096);
const change = {
  runId: key,
  /** The run version the person saw; a newer write is refused as a conflict. */
  expectedVersion: z.number().int().nonnegative(),
};

export const OffshiftPersonOperation = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    runId: key,
    outcome: text,
    endpoint: text,
    criteria: OffshiftCriteria,
    playbook: OffshiftPlaybookId.optional(),
  }),
  /** The run's full view, for edits that need more than the card holds. */
  z.strictObject({ action: z.literal("get"), runId: key }),
  /** Done with an optional note of what was seen, or back to to do. */
  z.strictObject({
    action: z.literal("step"),
    ...change,
    stepId: key,
    state: z.enum(["done", "todo"]),
    note: z.string().min(1).max(1024).optional(),
  }),
  /** The person's own check: it counts as independent of the run's agent. */
  z.strictObject({
    action: z.literal("evidence"),
    ...change,
    criterionId: key,
    kind: OffshiftEvidenceKind,
    result: z.enum(["pass", "fail"]),
    /** The revision the person looked at (the card's); a source change since is refused. */
    revision: OffshiftRevision,
    note: text,
    /** A URL or a file path the check rests on. */
    link: z.string().min(1).max(2048).optional(),
  }),
  z.strictObject({
    action: z.literal("revise"),
    ...change,
    criterion: OffshiftCriterion,
  }),
  /** One phase forward, or back to any earlier phase. */
  z.strictObject({ action: z.literal("advance"), ...change, phase: OffshiftPhase }),
  /** Clears the agent's recorded blocker with the person's decision. */
  z.strictObject({ action: z.literal("resume"), ...change, note: text }),
  /** Ends the run for good. */
  z.strictObject({ action: z.literal("end"), ...change, note: text.optional() }),
]);
export type OffshiftPersonOperation = z.infer<typeof OffshiftPersonOperation>;

const requestId = z.string().min(1).max(256);
/** Read needs read scope; every change needs operate scope. */
export const OffshiftClientRequest = z.object({
  type: z.literal("offshift.request"),
  requestId,
  threadId: ThreadId,
  op: OffshiftPersonOperation,
});
export type OffshiftClientRequest = z.infer<typeof OffshiftClientRequest>;

export const OffshiftClientResult = z.object({
  type: z.literal("offshift.result"),
  requestId,
  ok: z.boolean(),
  /**
   * `conflict`: the run changed since `expectedVersion` (the view holds it as it now stands);
   * `invalid`: the change is refused as it stands, `message` says why.
   */
  error: z.enum(["forbidden", "not_found", "conflict", "invalid", "unavailable"]).optional(),
  message: z.string().max(1024).optional(),
  view: OffshiftView.optional(),
});
export type OffshiftClientResult = z.infer<typeof OffshiftClientResult>;
