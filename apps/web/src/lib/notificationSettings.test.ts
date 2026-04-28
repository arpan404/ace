import { describe, expect, it } from "vitest";

import {
  buildAgentAttentionNotificationSettingsPatch,
  buildScopedAgentAttentionNotificationSettingsPatch,
  resolveNotificationToggleChangeIntent,
} from "./notificationSettings";

describe("notification settings helpers", () => {
  it("builds a full patch when enabling or disabling all notification categories", () => {
    expect(buildAgentAttentionNotificationSettingsPatch(true)).toEqual({
      notifyOnAgentCompletion: true,
      notifyOnApprovalRequired: true,
      notifyOnUserInputRequired: true,
    });
    expect(buildAgentAttentionNotificationSettingsPatch(false)).toEqual({
      notifyOnAgentCompletion: false,
      notifyOnApprovalRequired: false,
      notifyOnUserInputRequired: false,
    });
  });

  it("builds a scoped patch when only some categories should change", () => {
    expect(
      buildScopedAgentAttentionNotificationSettingsPatch(
        ["notifyOnApprovalRequired", "notifyOnUserInputRequired"],
        true,
      ),
    ).toEqual({
      notifyOnApprovalRequired: true,
      notifyOnUserInputRequired: true,
    });
  });

  it("requests permission instead of mutating settings immediately when enabling a toggle without permission", () => {
    expect(
      resolveNotificationToggleChangeIntent({
        checked: true,
        key: "notifyOnAgentCompletion",
        permission: "default",
      }),
    ).toEqual({
      checked: true,
      kind: "request-permission",
      keys: ["notifyOnAgentCompletion"],
    });
    expect(
      resolveNotificationToggleChangeIntent({
        checked: true,
        key: "notifyOnApprovalRequired",
        permission: "denied",
      }),
    ).toEqual({
      checked: true,
      kind: "request-permission",
      keys: ["notifyOnApprovalRequired"],
    });
  });

  it("updates only the requested toggle when permission is already granted or unsupported", () => {
    expect(
      resolveNotificationToggleChangeIntent({
        checked: true,
        key: "notifyOnUserInputRequired",
        permission: "granted",
      }),
    ).toEqual({
      checked: true,
      kind: "update",
      patch: {
        notifyOnUserInputRequired: true,
      },
    });
    expect(
      resolveNotificationToggleChangeIntent({
        checked: false,
        key: "notifyOnAgentCompletion",
        permission: "default",
      }),
    ).toEqual({
      checked: false,
      kind: "update",
      patch: {
        notifyOnAgentCompletion: false,
      },
    });
  });
});
