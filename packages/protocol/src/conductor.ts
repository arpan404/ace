import { validatePlan } from "./conductor-plan-validation.ts";
import { z } from "zod";
import { AgentId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const Text = z.string().min(1).max(16_384);
const Paths = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine(
        (p) =>
          !p.startsWith("/") &&
          !p.includes("\\") &&
          !p.split("/").includes("..") &&
          !Array.from(p).some((c) => c.charCodeAt(0) < 32) &&
          (p === "." || !p.split("/").some((segment) => segment === "" || segment === ".")) &&
          !/[*?[\]]/.test(p),
        "ownership must be a repository-relative path",
      ),
  )
  .max(128);
export const ConductorBrief = z.object({
  objective: Text,
  instructions: Text,
  acceptance: z
    .array(Text)
    .min(1)
    .max(64)
    .refine(
      (criteria) => new Set(criteria).size === criteria.length,
      "acceptance criteria must be distinct",
    ),
  files: Paths,
  packages: Paths,
  risks: z.array(Text).max(32),
});
export type ConductorBrief = z.infer<typeof ConductorBrief>;
export const ConductorWorkstream = z.object({
  id: Id,
  title: z.string().min(1).max(256),
  brief: ConductorBrief,
  dependencies: z.array(Id).max(256),
  priority: z.number().int().min(-1000).max(1000),
});
const PlanShape = z.object({
  summary: Text,
  workstreams: z.array(ConductorWorkstream).min(1).max(256),
});
function planSchema(caseSensitivity: "sensitive" | "insensitive") {
  return PlanShape.superRefine((plan, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 1_048_576) {
      ctx.addIssue({ code: "custom", message: "plan artifact exceeds 1 MiB" });
      return;
    }
    validatePlan(plan.workstreams, caseSensitivity, (message) =>
      ctx.addIssue({ code: "custom", message }),
    );
  });
}
export const ConductorPlan = planSchema("sensitive");
export const ConductorPlanOnInsensitiveFilesystem = planSchema("insensitive");
export type ConductorPlan = z.infer<typeof ConductorPlan>;
export const ConductorReview = z
  .object({
    verdict: z.enum(["pass", "changes_required"]),
    summary: Text,
    requirements: z
      .array(z.object({ criterion: Text, passed: z.boolean(), evidence: Text }))
      .min(1)
      .max(64),
    probes: z.array(Text).min(1).max(64),
    mutations: z
      .array(z.object({ change: Text, caught: z.boolean(), evidence: Text }))
      .min(15)
      .max(64),
    flakiness: z.object({
      runs: z.number().int().min(2).max(1000),
      passed: z.boolean(),
      evidence: Text,
    }),
    design: z.object({ passed: z.boolean(), evidence: Text }),
    performance: z.object({ passed: z.boolean(), evidence: Text }),
  })
  .superRefine((report, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(report)).byteLength > 65_536)
      ctx.addIssue({ code: "custom", message: "review artifact exceeds 64 KiB" });
    if (new Set(report.mutations.map((m) => m.change)).size !== report.mutations.length)
      ctx.addIssue({ code: "custom", message: "mutations must be distinct" });
    if (
      report.verdict === "pass" &&
      (!report.requirements.every((r) => r.passed) ||
        !report.mutations.every((m) => m.caught) ||
        !report.flakiness.passed ||
        !report.design.passed ||
        !report.performance.passed)
    )
      ctx.addIssue({ code: "custom", message: "passing review requires passing evidence" });
  });
export type ConductorReview = z.infer<typeof ConductorReview>;
export const ConductorModel = z.object({
  provider: ProviderKind,
  model: Id,
  tier: z.enum(["fast", "normal"]),
  cost: z.number().finite().nonnegative(),
  quota: z.number().finite().positive(),
});
export type ConductorModel = z.infer<typeof ConductorModel>;
export const ConductorSpec = z
  .object({
    rootAgentId: AgentId,
    workspaceId: WorkspaceId,
    goal: Text,
    repositoryRules: z.string().max(65_536),
    constraints: z.object({
      providers: z.array(ProviderKind).min(1).max(6),
      models: z.array(Id).min(1).max(64),
      accounts: z.array(Id).min(1).max(64),
      budget: z.number().finite().nonnegative(),
      maxParallel: z.number().int().min(1).max(64),
      deadline: z.number().int().nonnegative().nullable(),
      stallAfterMs: z.number().int().positive(),
    }),
    policies: z.object({
      planApproval: z.enum(["required", "auto"]),
      merge: z.enum(["auto-after-verification", "ask", "PR-only"]),
      maxFixRounds: z.number().int().min(0).max(10),
      roles: z.object({
        planner: z.array(ConductorModel).min(1).max(16),
        worker: z.array(ConductorModel).min(1).max(16),
        reviewer: z.array(ConductorModel).min(1).max(16),
        integrator: z.array(ConductorModel).min(1).max(16),
      }),
    }),
  })
  .superRefine((spec, ctx) => {
    for (const [role, choices] of Object.entries(spec.policies.roles)) {
      if (
        !choices.some(
          (m) =>
            spec.constraints.providers.includes(m.provider) &&
            spec.constraints.models.includes(m.model),
        )
      )
        ctx.addIssue({ code: "custom", message: `no allowed model for ${role}` });
      if (role === "reviewer" && choices.some((m) => m.tier !== "normal"))
        ctx.addIssue({ code: "custom", message: "reviewers must use normal tier" });
    }
  });
export type ConductorSpec = z.infer<typeof ConductorSpec>;
export const ConductorApproval = z.object({
  gateId: Id,
  decision: z.enum(["approve", "reject"]),
  plan: ConductorPlan.optional(),
  budget: z.number().finite().nonnegative().optional(),
  deadline: z.number().int().nonnegative().optional(),
});
export const ConductorCommandPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conductor.start"), runId: Id, spec: ConductorSpec }),
  z.object({ type: z.literal("conductor.approve"), runId: Id, approval: ConductorApproval }),
  z.object({ type: z.literal("conductor.pause"), runId: Id }),
  z.object({ type: z.literal("conductor.resume"), runId: Id }),
  z.object({ type: z.literal("conductor.cancel"), runId: Id }),
]);
export type ConductorCommandPayload = z.infer<typeof ConductorCommandPayload>;
