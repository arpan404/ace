import type { ScreenTarget } from "@ace/protocol";

/**
 * The apps whose windows show an iOS Simulator device: Simulator, and the device tool that
 * replaces it in newer Xcode. Their windows belong to the Devices switch, not to computer use.
 */
export const deviceWindowBundles: ReadonlySet<string> = new Set([
  "com.apple.iphonesimulator",
  "com.apple.dt.Devices",
]);

/** A window showing a Simulator device. */
export function deviceWindow(target: ScreenTarget): boolean {
  return target.kind === "window" && deviceWindowBundles.has(target.bundleId);
}

/** Only authenticated human control of a Simulator window bypasses agent focus checks. */
export function humanDeviceInput(actor: "human" | "agent", target: ScreenTarget): boolean {
  return actor === "human" && deviceWindow(target);
}
