import type { DeviceInput } from "@ace/protocol/devices";

/** Allow the gesture itself, or Android's per-character typing, plus transport overhead. */
export function deviceInputTimeout(input: DeviceInput): number {
  return (
    5000 +
    (input.kind === "swipe" || input.kind === "longPress"
      ? input.durationMs
      : input.kind === "type"
        ? input.text.length * 100
        : 0)
  );
}
