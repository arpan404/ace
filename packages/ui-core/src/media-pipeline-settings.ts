/*
 * Settings › Beta's one switch, the new media pipeline (ADR 0147), shared by the web and the
 * phone: its words, and how the setting it covers (`media.delivery`) reads as the switch. Live
 * video is always encoded by ace-media (`media.encode` has no other value), so only delivery is
 * left to turn on. Pure.
 */

export const mediaPipelineSwitch = {
  title: "New media pipeline",
  description:
    "Streams live video to your devices with ace-media; video that's already open moves over when you open it again.",
} as const;

/** The settings the switch writes, in the order it writes them. */
export const mediaPipelineKeys = ["media.delivery"] as const;

/** What the switch shows for the stored delivery setting: on only when it is `auto`. */
export function mediaPipelineState(delivery: unknown): { on: boolean } {
  return { on: delivery === "auto" };
}

/** The value the setting takes when the switch turns on or off. */
export function mediaPipelineValue(on: boolean): "auto" | "legacy" {
  return on ? "auto" : "legacy";
}

/** What a refused save says, with the machine's reason when it gave one. */
export function mediaPipelineRefused(on: boolean, reason?: string): string {
  return `Couldn't turn the new media pipeline ${on ? "on" : "off"}${reason ? `: ${reason}` : "."}`;
}
