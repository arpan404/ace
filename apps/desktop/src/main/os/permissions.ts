import { shell, systemPreferences } from "electron";
import type { PermissionPane, Permissions, ScreenPermission } from "../../shared/contract.ts";

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

/**
 * The app's microphone permission, for Spade's voice (ADR 0134, amended). macOS asks the
 * person once, the first time the page reaches for the microphone; a refusal stands until
 * they change it in System Settings. Elsewhere the page's own permission is all there is.
 */
export async function microphonePermission(): Promise<ScreenPermission> {
  if (process.platform !== "darwin") return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status !== "not-determined") return status;
  return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
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
  microphone: {
    darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    win32: "ms-settings:privacy-microphone",
  },
};

export async function openPermissionPane(pane: PermissionPane): Promise<boolean> {
  const url = panes[pane][process.platform];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
}
