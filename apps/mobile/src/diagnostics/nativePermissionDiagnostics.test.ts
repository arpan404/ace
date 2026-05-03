import { describe, expect, it } from "vitest";
import { runNativePermissionDiagnostics } from "./nativePermissionDiagnostics";

describe("runNativePermissionDiagnostics", () => {
  it("summarizes granted, blocked, and not-granted permission states", async () => {
    await expect(
      runNativePermissionDiagnostics([
        {
          kind: "notifications",
          label: "Notifications",
          getPermission: async () => ({ granted: true, status: "granted" }),
        },
        {
          kind: "camera",
          label: "Camera",
          getPermission: async () => ({
            granted: false,
            canAskAgain: false,
            status: "denied",
          }),
        },
        {
          kind: "photo-library",
          label: "Photo Library",
          getPermission: async () => ({
            granted: false,
            canAskAgain: true,
            status: "undetermined",
          }),
        },
      ]),
    ).resolves.toEqual([
      {
        kind: "notifications",
        label: "Notifications",
        state: "granted",
        detail: "Granted",
      },
      {
        kind: "camera",
        label: "Camera",
        state: "blocked",
        detail: "Blocked in system settings",
      },
      {
        kind: "photo-library",
        label: "Photo Library",
        state: "not-granted",
        detail: "Not granted (undetermined)",
      },
    ]);
  });
});
