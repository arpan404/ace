import type { DevicePermission } from "@ace/protocol/devices";
import { catalogHint, catalogWord } from "./catalog.ts";
import { catalogRefusal, DeviceError } from "./sdk.ts";

/**
 * macOS privacy permissions behind the iOS Simulator view: the screen helper ("Ace Screen
 * Helper", `dev.ace.screen-helper`) needs Screen Recording to show the Simulator window and
 * Accessibility to send it taps and keys. These errors say which one and how to grant it.
 */
const panes: Record<DevicePermission, string> = {
  screenRecording: "permissionScreenRecording",
  accessibility: "permissionAccessibility",
};

export function permissionDenied(permission: DevicePermission): DeviceError {
  const word = catalogWord(panes[permission]);
  return new DeviceError(word.code, word.message, word.hint, permission);
}

/** Screen helper and manager failures, by their stable messages, as typed device errors. */
export function screenFailure(error: unknown): DeviceError | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if ("code" in error && error.code === "screen_disabled") return catalogRefusal("screenDisabled");
  if (
    ("code" in error && (error.code === "foreground_required" || error.code === "focus_changed")) ||
    /Target window is not focused|Captured window must be the application's focused window|Focused element is not an Accessibility window/.test(
      message,
    )
  )
    return new DeviceError(
      "foreground_required",
      `Simulator needs foreground input for this interaction: ${message}`,
      catalogHint("foregroundRequiredHint"),
    );
  if (/Screen Recording permission (denied|revoked)/i.test(message))
    return permissionDenied("screenRecording");
  // Capture already proved Screen Recording; input is refused for Accessibility.
  if (/macOS permission denied/i.test(message)) return permissionDenied("accessibility");
  if (/only while it is the frontmost app/.test(message))
    return catalogRefusal("frontmostTyping");
  if (message === "Session limit") return catalogRefusal("screenLimit");
  return undefined;
}
