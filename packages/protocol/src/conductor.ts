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
  acceptance: z.array(Text).min(1).max(64),
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
const overlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === "." || b === ".";
export const ConductorPlan = z
  .object({
    summary: Text,
    workstreams: z.array(ConductorWorkstream).min(1).max(256),
  })
  .superRefine((plan, ctx) => {
    if (JSON.stringify(plan).length > 1_048_576)
      ctx.addIssue({ code: "custom", message: "plan artifact exceeds 1 MiB" });
    const nodes = new Map(plan.workstreams.map((w) => [w.id, w]));
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    if (nodes.size !== plan.workstreams.length) error("duplicate workstream id");
    const ancestors = new Map<string, Set<string>>();
    const visiting = new Set<string>();
    const visit = (id: string): Set<string> => {
      const cached = ancestors.get(id);
      if (cached) return cached;
      if (visiting.has(id)) {
        error("dependency cycle");
        return new Set();
      }
      visiting.add(id);
      const result = new Set<string>();
      const node = nodes.get(id);
      if (!node) error(`unknown dependency ${id}`);
      for (const dep of node?.dependencies ?? []) {
        result.add(dep);
        for (const a of visit(dep)) result.add(a);
      }
      visiting.delete(id);
      ancestors.set(id, result);
      return result;
    };
    for (const w of plan.workstreams) {
      if (new Set(w.dependencies).size !== w.dependencies.length) error("duplicate dependency");
      visit(w.id);
    }

    for (let i = 0; i < plan.workstreams.length; i++) {
      const a = plan.workstreams[i];
      if (!a) continue;
      for (const b of plan.workstreams.slice(i + 1)) {
        if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) continue;
        if (
          [...a.brief.files, ...a.brief.packages].some((p) =>
            [...b.brief.files, ...b.brief.packages].some((q) => overlap(p, q)),
          )
        ) {
          error(`unordered ownership overlap: ${a.id}, ${b.id}`);
        }
      }
    }
  });
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
    if (JSON.stringify(report).length > 65_536)
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
