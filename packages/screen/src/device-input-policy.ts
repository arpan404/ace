import type { ScreenTarget } from "@ace/protocol";

/** Only authenticated human control of a Simulator window bypasses agent focus checks. */
export function humanDeviceInput(actor: "human" | "agent", target: ScreenTarget): boolean {
  return (
    actor === "human" && target.kind === "window" && target.bundleId === "com.apple.iphonesimulator"
  );
}
