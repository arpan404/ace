import { z } from "zod";
import { ProviderKind } from "./provider.ts";

const text = z.string().min(1).max(256);
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
export const AutomationSchedule = z.object({
  kind: z.enum(["rrule", "cron"]),
  expression: z.string().min(1).max(1024),
  timezone: z.string().min(1).max(128),
  startAt: instant.refine((value) => value % 60_000 === 0, "DTSTART must have zero seconds"),
});
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;
export const AutomationTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("schedule"), schedule: AutomationSchedule }),
  z.object({
    kind: z.literal("github"),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(256),
    event: z.enum(["pr_changed", "ci_failed", "review_comment", "issue_labelled"]),
    label: text.optional(),
    pullRequest: z.number().int().positive().optional(),
    pollIntervalMs: z.number().int().min(60_000).max(86_400_000),
  }),
  z.object({ kind: z.literal("file"), paths: z.array(text).min(1).max(100) }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;
export const Automation = z.object({
  id: text,
  title: text,
  enabled: z.boolean(),
  workspace: z.string().min(1).max(4096),
  provider: ProviderKind,
  model: text.optional(),
  prompt: z.string().min(1).max(32_768),
  worktree: z.boolean(),
  trigger: AutomationTrigger,
  missedRun: z.enum(["skip", "run_once"]),
  concurrency: z.number().int().min(1).max(32),
  jitterMs: z.number().int().min(0).max(3_600_000),
});
export type Automation = z.infer<typeof Automation>;
export const TriggerVariables = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.]*$/)
      .max(128),
    z.string().max(8192),
  )
  .refine((v) => Object.keys(v).length <= 64);
export type TriggerVariables = z.infer<typeof TriggerVariables>;
export const AutomationEvent = z.object({
  key: z.string().min(1).max(512),
  variables: TriggerVariables,
});
export type AutomationEvent = z.infer<typeof AutomationEvent>;
export const AutomationRun = z.object({
  id: text,
  automationId: text,
  title: text,
  eventKey: z.string().max(512),
  trigger: z.enum(["schedule", "github", "file", "manual"]),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  startedAt: instant,
  finishedAt: instant.optional(),
  threadId: text.optional(),
  result: z.string().max(8192).optional(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;
export const AutomationInbox = z.object({
  runs: z.array(AutomationRun).max(100),
  before: z.number().int().positive().nullable(),
});
export type AutomationInbox = z.infer<typeof AutomationInbox>;
export const AutomationRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("automation.put"), requestId: text, automation: Automation }),
  z.object({ type: z.literal("automation.remove"), requestId: text, id: text }),
  z.object({
    type: z.literal("automation.run"),
    requestId: text,
    id: text,
    variables: TriggerVariables,
  }),
  z.object({ type: z.literal("automation.list"), requestId: text }),
  z.object({
    type: z.literal("automation.inbox"),
    requestId: text,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100),
  }),
]);
export type AutomationRequest = z.infer<typeof AutomationRequest>;
export const AutomationResponse = z.object({
  type: z.literal("automation.result"),
  requestId: text,
  ok: z.boolean(),
  error: z.string().max(8192).optional(),
  automations: z.array(Automation).max(1000).optional(),
  inbox: AutomationInbox.optional(),
  run: AutomationRun.optional(),
});
export type AutomationResponse = z.infer<typeof AutomationResponse>;
