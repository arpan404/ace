import { z } from "zod";
import { ThreadId, Timestamp } from "./ids.ts";
import { ProviderKind } from "./provider-data.ts";

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const text = z.string().min(1).max(4096);
export const OffshiftEvidenceKind = z.enum(["automated", "source", "ui", "human", "manual"]);
export type OffshiftEvidenceKind = z.infer<typeof OffshiftEvidenceKind>;
export const OffshiftPhase = z.enum(["plan", "implement", "verify", "review", "delivery"]);
export type OffshiftPhase = z.infer<typeof OffshiftPhase>;
/** Kinds of work a run assigns: writing code, planning and design, review, verification. */
export const OffshiftRole = z.enum(["build", "judgment", "review", "verify"]);
export type OffshiftRole = z.infer<typeof OffshiftRole>;
/** Who does one kind of work. Bounds match `delegate`'s provider, model and effort. */
export const OffshiftRoleSelection = z
  .strictObject({
    provider: ProviderKind.optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .refine(
    (selection) => Object.values(selection).some((value) => value !== undefined),
    "A role names at least a provider, model or effort",
  )
  .meta({ "x-ace-constraint": "A role names at least a provider, model or effort." });
export type OffshiftRoleSelection = z.infer<typeof OffshiftRoleSelection>;
/** Who does which kind of work; a role left out falls back to the project default. */
export const OffshiftRoles = z.strictObject({
  build: OffshiftRoleSelection.optional(),
  judgment: OffshiftRoleSelection.optional(),
  review: OffshiftRoleSelection.optional(),
  verify: OffshiftRoleSelection.optional(),
});
export type OffshiftRoles = z.infer<typeof OffshiftRoles>;
/** The thread that recorded something, from its authenticated lease and thread record. */
export const OffshiftAuthor = z.object({
  threadId: ThreadId,
  provider: ProviderKind,
  model: z.string().min(1).max(256).nullable(),
});
export type OffshiftAuthor = z.infer<typeof OffshiftAuthor>;
export const OffshiftCriterion = z.strictObject({
  id: key.describe("A stable id for the criterion (letters, digits, _ . -)."),
  description: text.describe("The observable behaviour that must hold."),
  requiredKinds: z
    .array(OffshiftEvidenceKind)
    .min(1)
    .max(5)
    .describe("Evidence kinds that must each have a current pass."),
  independent: z
    .boolean()
    .optional()
    .describe("Passes count only from another provider or model than the run owner's."),
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
/** Built-in playbooks: a named list of steps for one kind of work. */
export const OffshiftPlaybookId = z.enum([
  "fix",
  "feature",
  "refactor",
  "perf",
  "investigate",
  "ui",
  "land",
]);
export type OffshiftPlaybookId = z.infer<typeof OffshiftPlaybookId>;
export const OffshiftStepState = z.enum(["todo", "done", "skipped"]);
export type OffshiftStepState = z.infer<typeof OffshiftStepState>;
const stepTitle = z.string().min(1).max(160);
const stepNote = z.string().min(1).max(1024);
/** One step of a run's procedure, before it is tracked. */
export const OffshiftStepInput = z.strictObject({
  id: key.describe("A stable id for the step (letters, digits, _ . -)."),
  title: stepTitle.describe("What to do, as a short imperative."),
  phase: OffshiftPhase.describe("The phase the step belongs to."),
});
export type OffshiftStepInput = z.infer<typeof OffshiftStepInput>;
/** A run holds at most 24 steps, each id once. */
export const OffshiftStepsInput = z
  .array(OffshiftStepInput)
  .min(1)
  .max(24)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Step IDs must be unique",
  )
  .meta({ "x-ace-constraint": "Step IDs must be unique." });
export const OffshiftStep = OffshiftStepInput.extend({
  state: OffshiftStepState,
  /** What was observed when done, or why it was skipped. */
  note: stepNote.optional(),
});
export type OffshiftStep = z.infer<typeof OffshiftStep>;
/** A playbook step: a step with the evidence kinds its criteria usually need. */
export const OffshiftPlaybookStep = OffshiftStepInput.extend({
  kinds: z.array(OffshiftEvidenceKind).min(1).max(5).optional(),
});
export type OffshiftPlaybookStep = z.infer<typeof OffshiftPlaybookStep>;
export const OffshiftPlaybook = z.object({
  id: OffshiftPlaybookId,
  purpose: z.string().min(1).max(160),
  steps: z.array(OffshiftPlaybookStep).min(1).max(8),
});
export type OffshiftPlaybook = z.infer<typeof OffshiftPlaybook>;
/** What `playbooks` returns: every built-in playbook, to choose one at start. */
export const OffshiftPlaybooks = z.object({ playbooks: z.array(OffshiftPlaybook).max(16) });
export type OffshiftPlaybooks = z.infer<typeof OffshiftPlaybooks>;
export const OffshiftEvidence = z.strictObject({
  criterionId: key.describe("The criterion this observation checks."),
  kind: OffshiftEvidenceKind.describe("Which required kind this observation satisfies."),
  result: z.enum(["pass", "fail"]).describe("What the check observed."),
  revision: OffshiftRevision.describe("The revision from get, read before the check ran."),
  action: text.describe("The command or interaction actually performed."),
  artifact: text.describe("Where the full output is kept: a path, URL or report reference."),
  note: text.describe("The observed result and environment, in a sentence or two."),
  recordedAt: Timestamp,
  /** Set by the daemon from the authenticated caller, never from input; null for records
   * written before authorship was kept. */
  by: OffshiftAuthor.nullable().default(null),
});
export type OffshiftEvidence = z.infer<typeof OffshiftEvidence>;
export const OffshiftEvidenceInput = OffshiftEvidence.omit({ recordedAt: true, by: true });
/**
 * An omitted requestId keys the receipt by a hash of the normalized request, version
 * included, so a lost-response retry still applies once.
 */
const mutation = {
  runId: key,
  requestId: key.optional(),
  version: z.number().int().nonnegative(),
};
export const OffshiftRequest = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    runId: key,
    requestId: key.optional(),
    outcome: text,
    endpoint: text,
    criteria: OffshiftCriteria,
    roles: OffshiftRoles.optional(),
    /** The playbook's steps, then `steps`, ordered by phase. */
    playbook: OffshiftPlaybookId.optional(),
    steps: OffshiftStepsInput.optional(),
  }),
  z.strictObject({ action: z.literal("get"), runId: key }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("playbooks") }),
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
  /** Replaces the run's roles. */
  z.strictObject({ action: z.literal("roles"), ...mutation, roles: OffshiftRoles }),
  /** Marks a step done (note: what was observed) or skipped (note: why, required). */
  z.strictObject({
    action: z.literal("step"),
    ...mutation,
    stepId: key,
    state: z.enum(["done", "skipped"]),
    note: stepNote.optional(),
  }),
]);
export type OffshiftRequest = z.infer<typeof OffshiftRequest>;
/** Replaces the project's default roles, used by runs that leave a role out. */
export const OffshiftProjectRolesRequest = z.strictObject({
  action: z.literal("roles"),
  scope: z.literal("project"),
  roles: OffshiftRoles,
});
export type OffshiftProjectRolesRequest = z.infer<typeof OffshiftProjectRolesRequest>;
/** What the `offshift` operation carries: a run request, or the project's default roles. */
export const OffshiftCall = z.union([OffshiftRequest, OffshiftProjectRolesRequest]);
export type OffshiftCall = z.infer<typeof OffshiftCall>;
export const OffshiftProjectRoles = z.object({ scope: z.literal("project"), roles: OffshiftRoles });
export type OffshiftProjectRoles = z.infer<typeof OffshiftProjectRoles>;
export const OffshiftRun = z.object({
  id: key,
  threadId: ThreadId,
  outcome: text,
  endpoint: text,
  criteria: OffshiftCriteria,
  /** The owner's provider and model when the run started; independence is measured from it. */
  /** Null for runs started before the owner was kept: nothing then counts as independent. */
  owner: OffshiftAuthor.nullable().default(null),
  roles: OffshiftRoles,
  playbook: OffshiftPlaybookId.optional(),
  /** The run's procedure in phase order; runs started without one have none. */
  steps: z.array(OffshiftStep).max(24).default([]),
  phase: OffshiftPhase,
  version: z.number().int().nonnegative(),
  blocker: text.nullable(),
  note: text,
  evidence: z.array(OffshiftEvidence).max(320),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type OffshiftRun = z.infer<typeof OffshiftRun>;
/**
 * A required kind without a counting pass. `needs: "independent"` means it has a current pass,
 * but only from the owner's own provider and model.
 */
export const OffshiftPending = z.object({
  criterionId: key,
  kind: OffshiftEvidenceKind,
  needs: z.literal("independent").optional(),
});
export type OffshiftPending = z.infer<typeof OffshiftPending>;
export const OffshiftView = z.object({
  run: OffshiftRun,
  revision: OffshiftRevision,
  state: z.enum(["active", "blocked", "needs_evidence", "waiting_on_tree", "complete"]),
  pending: z.array(OffshiftPending).max(320),
  treeState: z.enum(["working", "waiting", "needs_you", "failed", "done", "unknown"]),
  /** The one call or step to take now, in a sentence. */
  next: z.string().min(1).max(1024),
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
export const OffshiftResult = z.union([
  OffshiftView,
  z.array(OffshiftRunSummary).max(32),
  OffshiftProjectRoles,
  OffshiftPlaybooks,
]);
export type OffshiftResult = z.infer<typeof OffshiftResult>;

/**
 * Where one required evidence kind stands at the write that produced a card: a current pass, a
 * current failure, a pass recorded at an older source revision, or nothing recorded yet.
 */
export const OffshiftEvidenceState = z.enum([
  "pass",
  "fail",
  "stale",
  "missing",
  /** A current pass on an independent criterion, but from the owner's own provider and model. */
  "not_independent",
]);
export type OffshiftEvidenceState = z.infer<typeof OffshiftEvidenceState>;
export const OffshiftCardCriterion = z.object({
  id: key,
  description: z.string().max(160),
  independent: z.boolean().default(false),
  /** One entry per required kind, in the criterion's order. */
  evidence: z
    .array(
      z.object({
        kind: OffshiftEvidenceKind,
        state: OffshiftEvidenceState,
        recordedAt: Timestamp.nullable(),
        /** Who recorded it, without thread ids; the model is clipped to 64 characters. */
        by: z
          .object({ provider: ProviderKind, model: z.string().max(64).nullable() })
          .nullable()
          .default(null),
      }),
    )
    .max(5),
});
export type OffshiftCardCriterion = z.infer<typeof OffshiftCardCriterion>;
/**
 * A bounded client card of one run, as observed at the write that produced it. Notes, actions
 * and artifacts stay in the record. Strings are clipped and lists capped (with their full
 * counts) so a card stays a few KB whatever the run holds.
 */
export const OffshiftRunCard = z.object({
  id: key,
  outcome: z.string().max(512),
  outcomeTruncated: z.boolean(),
  endpoint: z.string().max(256),
  phase: OffshiftPhase,
  blocker: z.string().max(512).nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
  revision: OffshiftRevision,
  /** The run's first criteria, in order; `criteriaCount` is how many it holds. */
  criteria: z.array(OffshiftCardCriterion).max(16),
  criteriaCount: z.number().int().min(1).max(64),
  /** Required kinds without a current pass, in run order; `pendingCount` is the full number. */
  pending: z.array(OffshiftPending).max(16),
  pendingCount: z.number().int().nonnegative().max(320),
  /** Each role the run uses, from the run itself or the project default at this write. */
  roles: z
    .array(
      z.object({
        role: OffshiftRole,
        source: z.enum(["run", "project"]),
        provider: ProviderKind.optional(),
        model: z.string().max(64).optional(),
        effort: z.string().max(64).optional(),
      }),
    )
    .max(4)
    .default([]),
  /** The current phase's steps, in order; a skipped step's reason is clipped to 160 characters. */
  steps: z
    .array(
      z.object({
        id: key,
        title: stepTitle,
        state: OffshiftStepState,
        reason: z.string().max(160).optional(),
      }),
    )
    .max(24)
    .default([]),
  /** The playbook the run started from; absent on runs without one and on older cards. */
  playbook: OffshiftPlaybookId.optional(),
  /** The run's next step as worded at this write, clipped; absent on older cards. */
  next: z.string().max(512).optional(),
});
export type OffshiftRunCard = z.infer<typeof OffshiftRunCard>;
/**
 * Where a thread's latest run stands, for its list row: `open` (not delivered, steps or
 * evidence left), `blocked` (a blocker is recorded) or `delivered` (in delivery with nothing
 * pending). Derived from the card; never means done on its own, since the tree may still work.
 */
export const OffshiftRunMark = z.object({
  phase: OffshiftPhase,
  state: z.enum(["open", "blocked", "delivered"]),
  pendingCount: z.number().int().nonnegative().max(320),
  playbook: OffshiftPlaybookId.optional(),
});
export type OffshiftRunMark = z.infer<typeof OffshiftRunMark>;
/** A thread-log event: an Offshift run of this thread changed. */
export const OffshiftUpdated = z.object({
  type: z.literal("offshift.updated"),
  card: OffshiftRunCard,
});
export type OffshiftUpdated = z.infer<typeof OffshiftUpdated>;
