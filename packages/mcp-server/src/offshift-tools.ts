import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import {
  OffshiftCriteria,
  OffshiftCriterion,
  OffshiftEvidenceInput,
  OffshiftPhase,
  OffshiftResult,
  OffshiftRoles,
  type OffshiftCall,
} from "@ace/protocol/offshift";
import { controlResult, controlTool, controlToolTimeoutMs, fields } from "./control-tool.ts";

/** Each action's required fields, named in its description and checked before anything runs. */
const mutation = ["runId", "version"] as const;
const needs = {
  start: ["runId", "outcome", "endpoint", "criteria"],
  get: ["runId"],
  list: [],
  advance: [...mutation, "phase", "note"],
  block: [...mutation, "note"],
  resume: [...mutation, "note"],
  evidence: [...mutation, "evidence"],
  revise: [...mutation, "criterion", "note"],
  roles: ["roles"],
} as const;
type Action = keyof typeof needs;
const actions = Object.keys(needs) as [Action, ...Action[]];
const text = z.string().min(1).max(4096);

const Input = z
  .strictObject({
    action: z
      .enum(actions)
      .describe(
        "start: open a run with its outcome, endpoint, criteria and optional roles. get: the run, revision, pending evidence and next. list: this thread's runs. advance: move to phase (one step forward, or back to repair). block: record a blocker in note. resume: clear it, with the decision in note. evidence: record one check's result. revise: add a criterion, or replace the one with its id and drop its evidence; not while blocked. roles: replace the run's roles (runId, version), or the project default with scope project.",
      ),
    runId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional()
      .describe("Every action but list: the run's id, chosen at start (letters, digits, _ . -)."),
    requestId: fields.requestId
      .optional()
      .describe("Optional on changes; omitted, an identical retry still applies once."),
    version: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Every change after start: the version the last result returned. A mismatch means the run changed; get it again.",
      ),
    outcome: text.optional().describe("start: the observable result the work delivers."),
    endpoint: text
      .optional()
      .describe("start: where the work stops, as authorized (local changes, an open PR, ...)."),
    criteria: OffshiftCriteria.optional().describe(
      "start: what must hold for the outcome, up to 64.",
    ),
    criterion: OffshiftCriterion.optional().describe(
      "revise: the new criterion, or the replacement for the one with its id.",
    ),
    phase: OffshiftPhase.optional().describe(
      "advance: plan, implement, verify, review, then delivery.",
    ),
    note: text.optional().describe("advance, block, resume and revise: why, in a sentence."),
    evidence: OffshiftEvidenceInput.optional().describe(
      "evidence: one check, at the revision get returned before it ran.",
    ),
    roles: OffshiftRoles.optional().describe(
      "start and roles: who does build, judgment, review and verify work ({provider, model, effort} each).",
    ),
    scope: z
      .enum(["run", "project"])
      .optional()
      .describe("roles: run (default) or project, the default for runs without that role."),
    runOwner: ThreadId.optional().describe(
      "get and evidence only: the ancestor thread whose run you check, as its brief named it.",
    ),
  })
  .superRefine((input, context) => {
    const fields: readonly string[] =
      input.action === "roles" && input.scope !== "project"
        ? [...needs.roles, ...mutation]
        : needs[input.action];
    for (const field of fields as (keyof Input)[])
      if (input[field] === undefined)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${input.action} needs ${field}.`,
        });
  })
  .meta({
    "x-ace-constraint":
      "start needs runId, outcome, endpoint and criteria; get needs runId; advance needs runId, version, phase and note; block and resume need runId, version and note; evidence needs runId, version and evidence; revise needs runId, version, criterion and note; roles needs roles, plus runId and version unless scope is project.",
  });
type Input = z.output<typeof Input>;

/** The one request an action stands for. Required fields were checked by the schema. */
function request(input: Input): OffshiftCall {
  const runId = input.runId ?? "";
  const change = {
    runId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    version: input.version ?? 0,
  };
  const note = input.note ?? "";
  switch (input.action) {
    case "start":
      return {
        action: "start",
        runId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        outcome: input.outcome ?? "",
        endpoint: input.endpoint ?? "",
        criteria: input.criteria ?? [],
        ...(input.roles ? { roles: input.roles } : {}),
      };
    case "get":
      return { action: "get", runId };
    case "list":
      return { action: "list" };
    case "advance":
      return { action: "advance", ...change, phase: input.phase ?? "plan", note };
    case "block":
    case "resume":
      return { action: input.action, ...change, note };
    case "evidence": {
      const evidence = input.evidence;
      if (!evidence) throw new Error("evidence needs evidence.");
      return { action: "evidence", ...change, evidence };
    }
    case "revise": {
      const criterion = input.criterion;
      if (!criterion) throw new Error("revise needs criterion.");
      return { action: "revise", ...change, criterion, note };
    }
    case "roles": {
      const roles = input.roles ?? {};
      return input.scope === "project"
        ? { action: "roles", scope: "project", roles }
        : { action: "roles", ...change, roles };
    }
  }
}

/**
 * The calling thread's durable record of a coding outcome: criteria, phase, blocker and
 * revision-bound evidence. It records work; other tools do it.
 */
export const offshift = controlTool({
  toolset: "offshift",
  timeoutMs: controlToolTimeoutMs,
  name: "offshift",
  title: "Record an Offshift run",
  riskClass: "thread-write",
  capability: "thread_control",
  description:
    "Keep this thread's durable record of a multi-step coding outcome: criteria, phase (plan, implement, verify, review, delivery), blocker, roles and evidence bound to the workspace's Git revision. It records work and never runs it. Changes take the last version. Every result's next says what to do now. Each action's fields are named in action's description.",
  input: Input,
  output: controlResult(OffshiftResult),
  run: (input, control) =>
    control.run({
      op: "offshift",
      request: request(input),
      ...(input.runOwner ? { runOwner: input.runOwner } : {}),
    }),
});
