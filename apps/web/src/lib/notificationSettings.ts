import type { AgentAttentionNotificationPermission } from "./agentAttentionNotifications";

export type AgentAttentionNotificationSettingKey =
  | "notifyOnAgentCompletion"
  | "notifyOnApprovalRequired"
  | "notifyOnUserInputRequired";

export type AgentAttentionNotificationSettingsPatch = Record<
  AgentAttentionNotificationSettingKey,
  boolean
>;

export type NotificationToggleChangeIntent =
  | {
      checked: boolean;
      kind: "request-permission";
      keys: readonly AgentAttentionNotificationSettingKey[];
    }
  | {
      checked: boolean;
      kind: "update";
      patch: Partial<AgentAttentionNotificationSettingsPatch>;
    };

export function buildAgentAttentionNotificationSettingsPatch(
  enabled: boolean,
): AgentAttentionNotificationSettingsPatch {
  return {
    notifyOnAgentCompletion: enabled,
    notifyOnApprovalRequired: enabled,
    notifyOnUserInputRequired: enabled,
  };
}

export function buildScopedAgentAttentionNotificationSettingsPatch(
  keys: readonly AgentAttentionNotificationSettingKey[],
  enabled: boolean,
): Partial<AgentAttentionNotificationSettingsPatch> {
  return Object.fromEntries(
    keys.map((key) => [key, enabled]),
  ) as Partial<AgentAttentionNotificationSettingsPatch>;
}

export function resolveNotificationToggleChangeIntent(input: {
  checked: boolean;
  key: AgentAttentionNotificationSettingKey;
  permission: AgentAttentionNotificationPermission;
}): NotificationToggleChangeIntent {
  if (input.checked && input.permission !== "granted" && input.permission !== "unsupported") {
    return {
      checked: input.checked,
      kind: "request-permission",
      keys: [input.key],
    };
  }

  return {
    checked: input.checked,
    kind: "update",
    patch: {
      [input.key]: input.checked,
    },
  };
}
