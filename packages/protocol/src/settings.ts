import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

const name = z.string().min(1).max(256);
const tier = z.enum(["default", "standard", "fast", "flex", "priority"]);
const effort = z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SettingsValues = z.object({
  "providers.default": ProviderKind,
  "providers.coder.provider": ProviderKind,
  "providers.coder.model": name,
  "providers.coder.tier": tier,
  "providers.coder.reasoningEffort": effort,
  "providers.reviewer.provider": ProviderKind,
  "providers.reviewer.model": name,
  "providers.reviewer.tier": tier,
  "providers.reviewer.reasoningEffort": effort,
  "providers.planner.provider": ProviderKind,
  "providers.planner.model": name,
  "providers.planner.tier": tier,
  "providers.planner.reasoningEffort": effort,
  "approvals.policy": z.enum(["ask", "on-failure", "never"]),
  "notifications.enabled": z.boolean(),
  "notifications.sound": z.boolean(),
  "notifications.onCompletion": z.boolean(),
  "notifications.onApproval": z.boolean(),
  "notifications.suppressWhenActive": z.boolean(),
  "notifications.onFailure": z.boolean(),
  "notifications.onMention": z.boolean(),
  "notifications.quietHours": z
    .object({
      start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    })
    .nullable(),
  "threads.useWorktree": z.boolean(),
  "threads.autoSettleAfter": z.enum(["1d", "2d", "1w", "never"]),
  "threads.unresponsiveAfter": z.enum(["2m", "5m", "15m"]),
  "threads.settleOnMerge": z.boolean(),
  "threads.settleOnClose": z.boolean(),
  "app.openAtLogin": z.boolean(),
  "logs.retention": z.enum(["7d", "30d", "forever"]),
  "remote.enabled": z.boolean(),
  "remote.transport": z.enum(["local", "lan", "tailscale", "relay"]),
  "conductor.planApproval": z.enum(["required", "optional"]),
  "conductor.mergePolicy": z.enum(["manual", "after-review", "after-checks"]),
  "conductor.maxFixRounds": z.number().int().min(0).max(100),
  "automations.enabled": z.boolean(),
  "automations.timezone": name,
  "automations.maxConcurrent": z.number().int().min(1).max(32),
  "plugins.enabled": z.array(name).max(256),
  "plugins.preferences": z.record(z.string().max(256), z.json()),
  "clients.theme": z.json(),
  "clients.keybindings": z.json(),
});
export type SettingsValues = z.infer<typeof SettingsValues>;
export const SettingsKey = SettingsValues.keyof();
export type SettingsKey = z.infer<typeof SettingsKey>;
export const SettingsDocument = z
  .object({
    version: z.literal(2),
    settings: SettingsValues.partial().catchall(z.json()),
  })
  .catchall(z.json());
export type SettingsDocument = z.infer<typeof SettingsDocument>;
export const SettingsScope = z.object({
  workspaceId: WorkspaceId.optional(),
  threadId: ThreadId.optional(),
});
export type SettingsScope = z.infer<typeof SettingsScope>;
export const SettingsLayer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("workspace"), workspaceId: WorkspaceId }),
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
]);
export type SettingsLayer = z.infer<typeof SettingsLayer>;
export const SettingsProvenance = z.enum(["defaults", "global", "workspace", "thread"]);
export type SettingsProvenance = z.infer<typeof SettingsProvenance>;
export const SettingsEntry = z.object({
  key: SettingsKey,
  value: z.json(),
  provenance: SettingsProvenance,
});
export type SettingsEntry = z.infer<typeof SettingsEntry>;
export const SettingsDiagnostic = z.object({
  layer: SettingsProvenance,
  code: z.enum(["parse", "validation", "version", "secret", "size", "io", "limit"]),
  message: z.string().max(512),
  offset: z.number().int().nonnegative().optional(),
});
export type SettingsDiagnostic = z.infer<typeof SettingsDiagnostic>;
const requestId = z.string().min(1).max(128);
export const SettingsGet = z.object({
  type: z.literal("settings.get"),
  requestId,
  key: SettingsKey,
  scope: SettingsScope,
});
export const SettingsSet = z.object({
  type: z.literal("settings.set"),
  requestId,
  key: z.string().min(1).max(256),
  value: z.json(),
  layer: SettingsLayer,
});
export const SettingsSubscribe = z.object({
  type: z.literal("settings.subscribe"),
  requestId,
  subscriptionId: z.string().min(1).max(128),
  keys: z.array(SettingsKey).min(1).max(32),
  scope: SettingsScope,
});
export const SettingsUnsubscribe = z.object({
  type: z.literal("settings.unsubscribe"),
  requestId,
  subscriptionId: z.string().min(1).max(128),
});
export const SettingsRequest = z.discriminatedUnion("type", [
  SettingsGet,
  SettingsSet,
  SettingsSubscribe,
  SettingsUnsubscribe,
]);
export type SettingsRequest = z.infer<typeof SettingsRequest>;
export const SettingsResult = z.object({
  type: z.literal("settings.result"),
  requestId,
  ok: z.boolean(),
  entries: z.array(SettingsEntry).max(32),
  diagnostics: z.array(SettingsDiagnostic).max(3),
});
export const SettingsChanged = z.object({
  type: z.literal("settings.changed"),
  subscriptionId: z.string(),
  entries: z.array(SettingsEntry).max(32),
});
export const SettingsDiagnosticMessage = z.object({
  type: z.literal("settings.diagnostic"),
  subscriptionId: z.string(),
  diagnostic: SettingsDiagnostic,
});
