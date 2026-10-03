import { LimitPolicy, ProviderKind, type SettingsKey } from "@ace/protocol";
import { z } from "zod";

/** A daemon setting the UI edits: its key, how to read it, and what it is when unset. */
export interface SettingDef<T> {
  key: SettingsKey;
  schema: z.ZodType<T>;
  fallback: T;
}

function setting<T>(key: SettingsKey, schema: z.ZodType<T>, fallback: T): SettingDef<T> {
  return { key, schema, fallback };
}

export const AutoSettle = z.enum(["1d", "2d", "1w", "never"]);
export const UnresponsiveAfter = z.enum(["2m", "5m", "15m"]);
export type AutoSettle = z.infer<typeof AutoSettle>;
export type UnresponsiveAfter = z.infer<typeof UnresponsiveAfter>;
export const LogRetention = z.enum(["7d", "30d", "forever"]);
export type LogRetention = z.infer<typeof LogRetention>;
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const QuietHours = z.object({ start: clock, end: clock });
export type QuietHours = z.infer<typeof QuietHours>;
/** Keymap id → keys in keymap notation. Only rebound shortcuts are stored. */
export const Keybindings = z.record(z.string().max(64), z.string().min(1).max(64));
export type Keybindings = z.infer<typeof Keybindings>;

export type LimitPolicy = z.infer<typeof LimitPolicy>;

/** Every daemon setting the app edits, by its key in the protocol's SettingsValues. */
export const settingKeys = {
  defaultProvider: setting("providers.default", ProviderKind, "claude"),
  worktree: setting("threads.useWorktree", z.boolean(), true),
  autoSettle: setting("threads.autoSettleAfter", AutoSettle, "2d"),
  settleOnMerge: setting("threads.settleOnMerge", z.boolean(), true),
  openAtLogin: setting("app.openAtLogin", z.boolean(), false),
  notifyNeedsYou: setting("notifications.onApproval", z.boolean(), true),
  notifyDone: setting("notifications.onCompletion", z.boolean(), true),
  notifyFailures: setting("notifications.onFailure", z.boolean(), true),
  notifyMentions: setting("notifications.onMention", z.boolean(), true),
  quietHours: setting<QuietHours | null>("notifications.quietHours", QuietHours.nullable(), null),
  sound: setting("notifications.sound", z.boolean(), true),
  unresponsiveAfter: setting("threads.unresponsiveAfter", UnresponsiveAfter, "5m"),
  logRetention: setting("logs.retention", LogRetention, "30d"),
  keybindings: setting<Keybindings>("clients.keybindings", Keybindings, {}),
  limitPolicy: setting<LimitPolicy>("threads.limitPolicy", LimitPolicy, "manual"),
};
