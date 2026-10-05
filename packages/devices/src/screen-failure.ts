import type { DevicePermission } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";

/**
 * macOS privacy permissions behind the iOS Simulator view: the screen helper ("Ace Screen
 * Helper", `dev.ace.screen-helper`) needs Screen Recording to show the Simulator window and
 * Accessibility to send it taps and keys. These errors say which one and how to grant it.
 */
const panes: Record<DevicePermission, { name: string; does: string }> = {
  screenRecording: { name: "Screen Recording", does: "show the Simulator" },
  accessibility: { name: "Accessibility", does: "send taps and keys to the Simulator" },
};

export function permissionDenied(permission: DevicePermission): DeviceError {
  const { name, does } = panes[permission];
  return new DeviceError(
    "permission_denied",
    `ace needs ${name} permission to ${does}`,
    `Open System Settings › Privacy & Security › ${name}, turn on Ace Screen Helper, then try again.`,
    permission,
  );
}

/** Screen helper and manager failures, by their stable messages, as typed device errors. */
export function screenFailure(error: unknown): DeviceError | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if (/Screen Recording permission (denied|revoked)/i.test(message))
    return permissionDenied("screenRecording");
  // Capture already proved Screen Recording; input is refused for Accessibility.
  if (/macOS permission denied/i.test(message)) return permissionDenied("accessibility");
  if (/only while it is the frontmost app/.test(message))
    return new DeviceError(
      "not_supported",
      "Typing reaches the Simulator only while Simulator is the frontmost app",
      "Click the Simulator window once, then type here. Or turn off Simulator's I/O › Keyboard › Connect Hardware Keyboard and tap the on-screen keyboard in the live view. With idb installed, ace types while Simulator stays in the background.",
    );
  if (message === "Session limit")
    return new DeviceError(
      "busy",
      "Another live view is using the screen helper",
      "Stop the other simulator's live view or screen session, then start this one.",
    );
  return undefined;
}
