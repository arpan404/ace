import { AccessMode } from "./permissions.ts";
import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { MessageText } from "./message-limits.ts";

const text = z.string().min(1).max(256);
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
export const AutomationSchedule = z.object({
  kind: z.enum(["rrule", "cron"]),
  expression: z.string().min(1).max(1024),
  timezone: z.string().min(1).max(128),
  startAt: instant
    .refine((value) => value % 60_000 === 0, "DTSTART must have zero seconds")
    .meta({
      multipleOf: 60_000,
      "x-ace-constraint": "DTSTART must be a multiple of 60000 milliseconds.",
    }),
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
  /** A signed POST to the automation's webhook URL (ADR 0158). The secret is never here. */
  z.object({ kind: z.literal("webhook") }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;
export const Automation = z.object({
  id: text,
  title: text,
  enabled: z.boolean(),
  workspace: z.string().min(1).max(4096),
  provider: ProviderKind,
  access: AccessMode.optional(),
  model: text.optional(),
  /** The model's effort, as the composer's model chip sets it. Omitted: the model's default. */
  effort: z.string().min(1).max(64).optional(),
  /** The provider account instance to run on, as the chip's account rail picks it. */
  instance: text.optional(),
  prompt: MessageText,
  worktree: z.boolean(),
  trigger: AutomationTrigger,
  missedRun: z.enum(["skip", "run_once"]),
  /**
   * Kept for stored definitions. Every run goes into the automation's one thread, so one runs
   * at a time whatever this says: a fire meanwhile waits behind it.
   */
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
  .refine((v) => Object.keys(v).length <= 64)
  .meta({ maxProperties: 64, "x-ace-constraint": "At most 64 entries." });
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
  trigger: z.enum(["schedule", "github", "file", "manual", "webhook"]),
  /**
   * `queued` waits for the run before it to finish, then starts; an automation sends one message
   * at a time into its thread. `startedAt` is when it fired until it starts, then when it started.
   */
  status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
  startedAt: instant,
  finishedAt: instant.optional(),
  threadId: text.optional(),
  result: z.string().max(8192).optional(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;
export const AutomationRevision = z.number().int().positive();
/**
 * Which store a request addresses: the person's automations (the default) or the ones agents
 * made from a thread, which belong to that thread.
 */
export const AutomationSource = z.enum(["person", "thread"]);
export type AutomationSource = z.infer<typeof AutomationSource>;
export type AutomationRevision = z.infer<typeof AutomationRevision>;
export const AutomationInbox = z.object({
  runs: z.array(AutomationRun).max(100),
  before: z.number().int().positive().nullable(),
});
export type AutomationInbox = z.infer<typeof AutomationInbox>;
export const AutomationRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("automation.put"),
    requestId: text,
    automation: Automation,
    expectedRevision: AutomationRevision.nullable().optional(),
  }),
  z.object({
    type: z.literal("automation.remove"),
    requestId: text,
    id: text,
    expectedRevision: AutomationRevision.nullable().optional(),
    source: AutomationSource.optional(),
  }),
  z.object({
    type: z.literal("automation.run"),
    requestId: text,
    id: text,
    variables: TriggerVariables,
    /** Extra instructions for this run only, added after the saved prompt. */
    message: MessageText.optional(),
    source: AutomationSource.optional(),
  }),
  z.object({
    type: z.literal("automation.list"),
    requestId: text,
    /** Also list automations agents made from threads, in `threadAutomations`. */
    includeThreads: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("automation.inbox"),
    requestId: text,
    before: z.number().int().positive().optional(),
    automationId: text.optional(),
    limit: z.number().int().min(1).max(100),
    /**
     * Leave out runs that finished at or before this time (ms); runs still going stay in. Paging
     * with `before` goes over what is left. A daemon without it lists every run.
     */
    finishedAfter: z.number().int().nonnegative().optional(),
    source: AutomationSource.optional(),
  }),
  z.object({
    type: z.literal("automation.setEnabled"),
    requestId: text,
    id: text,
    enabled: z.boolean(),
    expectedRevision: AutomationRevision.optional(),
    source: AutomationSource.optional(),
  }),
  z.object({
    type: z.literal("automation.retry"),
    requestId: text,
    id: text,
    expectedRevision: AutomationRevision.optional(),
  }),
]);
export type AutomationRequest = z.infer<typeof AutomationRequest>;
export const AutomationPollError = z.object({
  message: z.string().max(8192),
  at: instant,
});
export type AutomationPollError = z.infer<typeof AutomationPollError>;
export const AutomationTriggerError = z.object({
  message: z.string().max(8192),
  at: instant,
});
export type AutomationTriggerError = z.infer<typeof AutomationTriggerError>;
/** A way in for webhooks: ace cloud's relay, the Tailscale listener, or the person's own URL. */
export const AutomationWebhookVia = z.enum(["custom", "tailscale", "relay"]);
export type AutomationWebhookVia = z.infer<typeof AutomationWebhookVia>;
/**
 * A webhook automation's addresses, as the person's lists show them (ADR 0158). `urls` has one
 * per way in that is on and serving, those ace cloud doesn't carry first; `url` is the first of
 * them, null until the person creates its secret or while no way in serves (`problem` says why).
 */
export const AutomationWebhookState = z.object({
  /** Whether a secret exists: false until the person creates one, and after revoking it. */
  active: z.boolean(),
  /** `/hooks/<hookId>` while active: the URL's path after the machine's base. Not a secret. */
  path: z
    .string()
    .regex(/^\/hooks\/[0-9a-f]{32}$/)
    .nullable(),
  url: z.url().max(2048).nullable(),
  urls: z.array(z.object({ via: AutomationWebhookVia, url: z.url().max(2048) })).max(3),
  problem: z.string().max(512).optional(),
});
export type AutomationWebhookState = z.infer<typeof AutomationWebhookState>;
export const AutomationResponse = z.object({
  type: z.literal("automation.result"),
  requestId: text,
  ok: z.boolean(),
  error: z.string().max(8192).optional(),
  automations: z.array(Automation).max(1000).optional(),
  schedules: z
    .array(
      z.object({
        id: text,
        nextRunAt: instant.nullable(),
        revision: AutomationRevision.optional(),
        lastPollError: AutomationPollError.optional(),
        triggerError: AutomationTriggerError.optional(),
        lastRun: AutomationRun.optional(),
        webhook: AutomationWebhookState.optional(),
      }),
    )
    .max(1000)
    .optional(),
  inbox: AutomationInbox.optional(),
  run: AutomationRun.optional(),
  /** With `includeThreads`: automations agents made from threads, with the thread that owns each. */
  threadAutomations: z
    .array(
      z.object({
        automation: Automation,
        threadId: text,
        nextRunAt: instant.nullable(),
        revision: AutomationRevision.optional(),
        triggerError: AutomationTriggerError.optional(),
        lastRun: AutomationRun.optional(),
        webhook: AutomationWebhookState.optional(),
      }),
    )
    .max(1000)
    .optional(),
});
export type AutomationResponse = z.infer<typeof AutomationResponse>;
/**
 * The person's webhook secret controls (ADR 0158). Outside `AutomationRequest` on purpose: agents'
 * `automation.manage` carries only those, so no agent tool can create, read or rotate a secret.
 * `rotate` makes a secret (and the hook id, the first time) and returns it once; `revoke` deletes
 * both, so the URL stops answering. `source: "thread"` addresses an automation an agent made
 * from a thread; agents can make a webhook automation, but only the person makes its secret.
 */
export const AutomationWebhookRequest = z.object({
  type: z.literal("automation.webhook"),
  requestId: text,
  id: text,
  action: z.enum(["rotate", "revoke"]),
  source: AutomationSource.optional(),
});
export type AutomationWebhookRequest = z.infer<typeof AutomationWebhookRequest>;
export const AutomationWebhookResponse = z.object({
  type: z.literal("automation.webhookResult"),
  requestId: text,
  ok: z.boolean(),
  error: z.string().max(8192).optional(),
  webhook: AutomationWebhookState.optional(),
  /** With `rotate`: the new secret, shown to the person once and never sent again. */
  secret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/]{43}=$/)
    .optional(),
});
export type AutomationWebhookResponse = z.infer<typeof AutomationWebhookResponse>;
