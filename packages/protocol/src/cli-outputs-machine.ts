import { z } from "zod";
import { AutomationResponse } from "./automations.ts";
import { DiagnosticCheck, DiagnosticRepair } from "./diagnostics.ts";
import { JsonValue } from "./json.ts";
import { SpadeStatus } from "./spade.ts";
import { StorageApply, StorageCompaction, StoragePlan, StorageUsage } from "./storage.ts";

/**
 * `--json` success values for This machine and Spade (ADR 0178 §7): the daemon, its service,
 * storage, settings, repair, Spade, Beta switches and automations. Keyed into `cliOutputs`.
 */

/** One log record as the daemon writes it to `logs/ace.jsonl`. */
export const CliLogRecord = z
  .object({
    at: z.number(),
    level: z.enum(["debug", "info", "warn", "error"]),
    component: z.string(),
    message: z.string(),
    data: z.unknown(),
  })
  .loose();
export type CliLogRecord = z.infer<typeof CliLogRecord>;

/** `ace service …`: whether the login service runs, as the service manager says. */
export const CliServiceState = z
  .object({ active: z.boolean(), linger: z.literal(true).optional() })
  .loose();

/** A cleanup receipt; its plan id and revision name what to read or apply again. */
export const CliCleanupReceipt = StorageApply.extend({ revision: z.string().optional() });

/** One setting as `ace config` reads it. */
export const CliConfigEntry = z.object({
  /** The name the command was given: a settings key, or one of the old short names. */
  setting: z.string(),
  /** The saved key behind it, as the app's Settings writes it. */
  key: z.string(),
  /** The value in force. */
  value: JsonValue,
  source: z.enum(["default", "saved", "environment"]),
  /** The environment variable that overrides the saved value, when one does. */
  overriddenBy: z.string().optional(),
  /** False when no daemon was reachable: a saved value applies when it next starts. */
  live: z.boolean(),
});
export type CliConfigEntry = z.infer<typeof CliConfigEntry>;

export const CliDoctorReport = z
  .object({
    at: z.number(),
    checks: z.array(DiagnosticCheck),
    planned: z.array(z.unknown()),
    repairs: z.array(DiagnosticRepair),
  })
  .loose();

/** `ace spade status`: the switches, and Spade's own state when a daemon answered. */
export const CliSpadeStatus = z.object({
  /** Settings › Beta shows Spade on this machine. */
  beta: z.boolean(),
  /** Spade is turned on (`spade.enabled`). */
  enabled: z.boolean(),
  /** A daemon answered; without one, `status` is absent and nothing runs. */
  live: z.boolean(),
  status: SpadeStatus.optional(),
});

export const CliSpadeSwitch = z.object({
  enabled: z.boolean(),
  live: z.boolean(),
  /** `spade on` turned Settings › Beta's Spade switch on first. */
  beta: z.literal(true).optional(),
});

/** One of Spade's bots, as its roster row shows it. */
export const CliSpadeBot = z.object({
  id: z.string(),
  kind: z.enum(["main", "bot"]),
  name: z.string(),
  task: z.string(),
  model: z.string(),
  conversation: z.string(),
  /**
   * `paused`: the person paused it (ADR 0200 §6.1). `updating`: its package update or rollback
   * is being applied (§6.2), which counts as working.
   */
  state: z.enum(["idle", "working", "waiting", "paused", "updating"]),
  waitingFor: z.enum(["approval", "question"]).optional(),
  status: z.string().optional(),
  problem: z.string().optional(),
  unseen: z.boolean(),
  pinned: z.boolean(),
  lastActivity: z.number(),
  lastMessage: z
    .object({ from: z.enum(["person", "agent"]), text: z.string(), at: z.number() })
    .optional(),
  parent: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type CliSpadeBot = z.infer<typeof CliSpadeBot>;

/** One bot as `ace bot running` shows it (ADR 0200 §6.3). */
export const CliRunningBot = z.object({
  id: z.string(),
  kind: z.enum(["main", "bot"]),
  name: z.string(),
  /** `updating`: its package update or rollback is being applied; it reads `working`. */
  state: z.enum(["idle", "working", "waiting", "sleeping", "paused", "updating"]),
  /** How it reads, in the order rows sort. */
  reads: z.enum(["needs_you", "working", "failed", "sleeping", "paused", "idle"]),
  /** Its state in words: "Checking fares", "Waiting on you: a question", "Paused". */
  doing: z.string(),
  uses: z.string(),
  spend: z.object({ todayMicros: z.number(), monthMicros: z.number(), unusual: z.boolean() }),
  network: z.object({ bytes: z.number(), hosts: z.array(z.string()), refused: z.number() }),
  nextWake: z.object({ at: z.number(), what: z.string() }).optional(),
  workers: z.array(z.object({ id: z.string(), name: z.string(), doing: z.string() })),
  actions: z.array(z.enum(["stop", "pause", "resume"])),
});
export type CliRunningBot = z.infer<typeof CliRunningBot>;

/** `ace bot stop|pause|resume BOT`: what was done, and the bot as it reads after. */
export const CliBotAction = z.object({
  bot: z.string(),
  name: z.string(),
  action: z.enum(["stop", "pause", "resume"]),
  /** False when there was nothing to do: nothing ran, or it was paused or running already. */
  changed: z.boolean(),
  now: CliRunningBot.optional(),
});
export type CliBotAction = z.infer<typeof CliBotAction>;

/** `ace spade chat BOT TEXT`: the message Spade took, and the reply when one came in time. */
export const CliSpadeChat = z.object({
  bot: z.string(),
  conversation: z.string(),
  reply: z.string().optional(),
});

/** `ace spade move BOT --to MACHINE` (ADR 0187): where the bot went and how the move ended. */
export const CliSpadeMove = z.object({
  bot: z.object({ id: z.string(), name: z.string() }),
  to: z.object({ host: z.string(), name: z.string() }),
  state: z.enum(["done", "cancelled"]),
});
export type CliSpadeMove = z.infer<typeof CliSpadeMove>;

export const CliFeatures = z.object({ spade: z.boolean(), marketplace: z.boolean() });
export const CliFeatureSwitch = z
  .object({ live: z.boolean(), spade: z.boolean().optional(), marketplace: z.boolean().optional() })
  .loose();

export const cliMachineOutputs = {
  "daemon.token": z.object({ token: z.string() }),
  "daemon.logs": z.array(CliLogRecord),
  "daemon.logs.record": z.object({ type: z.literal("log"), record: CliLogRecord }),
  service: CliServiceState,
  "storage.usage": StorageUsage,
  "storage.plan": StoragePlan,
  "storage.clean": z.union([
    StoragePlan,
    z.object({ plan: StoragePlan, apply: CliCleanupReceipt.nullable() }),
  ]),
  "storage.receipt": CliCleanupReceipt,
  "storage.compact": StorageCompaction,
  "config.list": z.array(CliConfigEntry),
  "config.entry": CliConfigEntry,
  doctor: CliDoctorReport,
  "doctor.bundle": z.object({ path: z.string() }),
  triage: z.object({
    folder: z.string(),
    playbook: z.string(),
    facts: z.string(),
    launch: z.string(),
    agents: z.array(z.string()),
  }),
  "spade.status": CliSpadeStatus,
  "spade.switch": CliSpadeSwitch,
  "spade.bot.list": z.array(CliSpadeBot),
  "spade.bot.show": CliSpadeBot,
  "spade.chat": CliSpadeChat,
  "bot.running": z.array(CliRunningBot),
  "bot.action": CliBotAction,
  "spade.move": CliSpadeMove,
  "feature.list": CliFeatures,
  "feature.switch": CliFeatureSwitch,
  "automation.list": AutomationResponse.loose(),
  "automation.show": AutomationResponse.loose(),
  "automation.receipt": AutomationResponse.extend({
    idempotencyKey: z.string(),
    automationId: z.string(),
  }).loose(),
} satisfies Record<string, z.ZodType>;
