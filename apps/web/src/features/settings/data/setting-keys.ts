import { LimitPolicy, SettingsValues, type SettingsKey } from "@ace/protocol";
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
export const FollowUp = z.enum(["queue", "steer"]);
export type FollowUp = z.infer<typeof FollowUp>;
/** Keymap id → keys in keymap notation. Only rebound shortcuts are stored. */
export const Keybindings = z.record(z.string().max(64), z.string().min(1).max(64));
export type Keybindings = z.infer<typeof Keybindings>;

export type LimitPolicy = z.infer<typeof LimitPolicy>;

/**
 * Every daemon setting the app edits, by its key in the protocol's SettingsValues. Only keys
 * something acts on belong here: the login item and this computer's notifications are the
 * desktop app's own (`useDesktopPreferences`). The default provider isn't one: it has no value
 * of its own until the person picks one (`useStartingProvider`), so Reset can't write it back.
 */
export const settingKeys = {
  hostName: setting("host.displayName", SettingsValues.shape["host.displayName"], ""),
  hostIcon: setting("host.icon", SettingsValues.shape["host.icon"], { kind: "laptop" }),
  remoteEnabled: setting("remote.enabled", z.boolean(), false),
  remoteTransport: setting("remote.transport", SettingsValues.shape["remote.transport"], "local"),
  relayUrl: setting("remote.relayUrl", SettingsValues.shape["remote.relayUrl"], ""),
  worktree: setting("threads.useWorktree", z.boolean(), true),
  autoSettle: setting("threads.autoSettleAfter", AutoSettle, "2d"),
  settleOnMerge: setting("threads.settleOnMerge", z.boolean(), true),
  settleOnClose: setting("threads.settleOnClose", z.boolean(), false),
  followUp: setting("threads.followUpBehavior", FollowUp, "queue"),
  continueAfterRestart: setting("threads.continueAfterRestart", z.boolean(), false),
  automations: setting("automations.enabled", z.boolean(), false),
  unresponsiveAfter: setting("threads.unresponsiveAfter", UnresponsiveAfter, "5m"),
  keybindings: setting<Keybindings>("clients.keybindings", Keybindings, {}),
  limitPolicy: setting<LimitPolicy>("threads.limitPolicy", LimitPolicy, "manual"),
};
