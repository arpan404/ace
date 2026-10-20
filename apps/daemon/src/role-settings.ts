import type { RunRole } from "@ace/protocol";
import type { SettingsService } from "@ace/settings";
import {
  configuredRoles,
  roleSettingKeys,
  type ConfiguredRoles,
  type RoleChoice,
} from "@ace/settings/roles";

/**
 * The person's global role settings, held for synchronous reads: `delegate` resolves runRole
 * from them and each new session renders them into its instructions once.
 */
export class RoleSettingsState {
  private values: Partial<Record<string, unknown>> = {};
  private roles: ConfiguredRoles = {};
  current(): ConfiguredRoles {
    return this.roles;
  }
  get(role: RunRole): RoleChoice | undefined {
    return this.roles[role];
  }
  async start(settings: Pick<SettingsService, "subscribe" | "read">): Promise<() => void> {
    const update = (entries: readonly { key: string; value: unknown }[]) => {
      for (const entry of entries) this.values[entry.key] = entry.value;
      this.roles = configuredRoles(this.values);
    };
    const stop = await settings.subscribe({ keys: roleSettingKeys, scope: {} }, (notification) => {
      if (notification.type === "changed") update(notification.entries);
    });
    update((await settings.read({ keys: roleSettingKeys, scope: {} })).entries);
    return stop;
  }
}
