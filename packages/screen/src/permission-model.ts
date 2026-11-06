import { ScreenPermissions, ScreenPermissionsV2 } from "@ace/protocol";

/** Normalize old helpers at the I/O boundary, using the daemon's injected host platform. */
export function hostPermissions(raw: unknown, platform: NodeJS.Platform): ScreenPermissions {
  const legacy = ScreenPermissions.safeParse(raw);
  if (legacy.success) {
    if (legacy.data.requirements) return { ...legacy.data, platform };
    if (platform === "darwin") return legacy.data;
    return {
      ...legacy.data,
      platform,
      requirements: [
        {
          kind: "helperRequirements",
          state: "unknown",
          title: platform === "win32" ? "Windows desktop access" : "Linux desktop access",
          message:
            "This screen helper does not report platform requirements. Update ace on this machine, then check again.",
        },
      ],
    };
  }
  const portable = ScreenPermissionsV2.parse(raw);
  return hostPermissions(
    {
      screenRecording: ["granted", "n/a"].includes(portable.screen),
      accessibility: ["granted", "n/a"].includes(portable.input),
    },
    platform,
  );
}

export function desktopAccessFailure(permissions: ScreenPermissions): string {
  if (!permissions.platform || permissions.platform === "darwin")
    return !permissions.screenRecording
      ? "Screen Recording permission denied"
      : "macOS permission denied";
  const platform = permissions.platform === "win32" ? "Windows" : "Linux";
  const missing = permissions.requirements?.find(
    (item) => item.state === "blocked" || item.state === "denied",
  );
  return `${platform} desktop access denied. ${missing?.message ?? "Check computer use requirements on the host machine."}`;
}

export function unavailablePermissions(
  platform: NodeJS.Platform,
  message: string,
): ScreenPermissions {
  return {
    screenRecording: false,
    accessibility: false,
    platform,
    requirements: [
      {
        kind: "desktopConnection",
        state: "blocked",
        title: platform === "win32" ? "Windows desktop connection" : "Linux desktop connection",
        message: message.slice(0, 2048),
      },
    ],
  };
}
