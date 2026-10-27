import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import {
  OffshiftCriteria,
  OffshiftCriterion,
  OffshiftEvidenceBatch,
  OffshiftEvidenceInput,
  OffshiftPhase,
  OffshiftPlaybookId,
  OffshiftResult,
  OffshiftStepsInput,
  type OffshiftRequest,
} from "@ace/protocol/offshift";
import { controlResult, controlTool, controlToolTimeoutMs, fields } from "./control-tool.ts";

/** Each action's required fields, named in its description and checked before anything runs. */
const mutation = ["runId", "version"] as const;
const needs = {
  start: ["runId", "outcome", "endpoint", "criteria"],
  get: ["runId"],
  list: [],
  playbooks: [],
  advance: [...mutation, "phase", "note"],
  block: [...mutation, "note"],
  resume: [...mutation, "note"],
  evidence: [...mutation, "evidence"],
  revise: [...mutation, "criterion", "note"],
  step: [...mutation, "stepId", "state"],
} as const;
type Action = keyof typeof needs;
const actions = Object.keys(needs) as [Action, ...Action[]];
const text = z.string().min(1).max(4096);

const Input = z
  .strictObject({
    action: z
      .enum(actions)
      .describe(
        "start: outcome, endpoint, criteria. Later changes: runId, version. advance: phase. revise: criterion. step: stepId, state. Note why on each.",
      ),
    runId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    version: z.number().int().nonnegative().optional().describe("run.version, as next names it."),
    outcome: text.optional(),
    endpoint: text.optional(),
    criteria: OffshiftCriteria.optional(),
    criterion: OffshiftCriterion.optional(),
    phase: OffshiftPhase.optional(),
    note: text.optional(),
    playbook: OffshiftPlaybookId.optional(),
    steps: OffshiftStepsInput.optional(),
    stepId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    state: z.enum(["done", "skipped"]).optional(),
    evidence: z
      .union([OffshiftEvidenceInput, OffshiftEvidenceBatch])
      .optional()
      .describe("A list is recorded whole or not at all."),
    runOwner: ThreadId.optional().describe("The ancestor whose run you check."),
  })
  .superRefine((input, context) => {
    for (const field of needs[input.action])
      if (input[field] === undefined)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${input.action} needs ${field}.`,
        });
  })
  .meta({
    "x-ace-constraint":
      "start needs runId, outcome, endpoint and criteria; get needs runId; advance needs runId, version, phase and note; block and resume need runId, version and note; evidence needs runId, version and evidence; revise needs runId, version, criterion and note; step needs runId, version, stepId and state.",
  });
type Input = z.output<typeof Input>;

/** The one request an action stands for. Required fields were checked by the schema. */
function request(input: Input): OffshiftRequest {
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
        ...(input.playbook ? { playbook: input.playbook } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
      };
    case "get":
      return { action: "get", runId };
    case "list":
    case "playbooks":
      return { action: input.action };
    case "advance":
      return { action: "advance", ...change, phase: input.phase ?? "plan", note };
    case "block":
    case "resume":
      return { action: input.action, ...change, note };
    case "evidence": {
      const evidence = input.evidence;
      if (!evidence) throw new Error("evidence needs evidence.");
      return {
        action: "evidence",
        ...change,
        evidence: Array.isArray(evidence) ? evidence : [evidence],
      };
    }
    case "revise": {
      const criterion = input.criterion;
      if (!criterion) throw new Error("revise needs criterion.");
      return { action: "revise", ...change, criterion, note };
    }
    case "step":
      return {
        action: "step",
        ...change,
        stepId: input.stepId ?? "",
        state: input.state ?? "done",
        ...(input.note === undefined ? {} : { note: input.note }),
      };
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
    "This thread's durable record of a coding outcome: criteria, steps, phase, blocker, evidence. It records work, never runs it. Do what each result's next says. How: guide offshift.",
  input: Input,
  output: controlResult(OffshiftResult),
  run: (input, control) =>
    control.run({
      op: "offshift",
      request: request(input),
      ...(input.runOwner ? { runOwner: input.runOwner } : {}),
    }),
});
