import { shell, systemPreferences } from "electron";
import type { PermissionPane, Permissions } from "../../shared/contract.ts";

/**
 * macOS privacy state for screen and computer use. The app never prompts on its own: the
 * Screen and computer-use features ask for these only when a person enables them, and the
 * onboarding screen deep-links to the right System Settings pane. The screen helper
 * (`dev.ace.screen-helper`) holds its own grants; this reports the app's.
 */
export function permissions(): Permissions {
  if (process.platform !== "darwin") return { screenRecording: "granted", accessibility: true };
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

const panes: Record<PermissionPane, Partial<Record<NodeJS.Platform, string>>> = {
  "screen-recording": {
    darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
  accessibility: {
    darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  notifications: {
    darwin: "x-apple.systempreferences:com.apple.preference.notifications",
    win32: "ms-settings:notifications",
  },
};

export async function openPermissionPane(pane: PermissionPane): Promise<boolean> {
  const url = panes[pane][process.platform];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}
