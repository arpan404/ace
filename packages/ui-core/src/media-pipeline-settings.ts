/*
 * Settings › Beta's one switch, the new media pipeline (ADR 0147), shared by the web and the
 * phone: its words, and how the two settings it covers (`media.encode`, `media.delivery`) read
 * as one switch. On means both are `auto`; anything else shows off, and a mixed pair says only
 * part is on. Pure.
 */

export const mediaPipelineSwitch = {
  title: "New media pipeline",
  description:
    "Encodes and streams live video with ace-media; encoding switches at once, and video that's already open moves over when you open it again.",
  partly: "Only part of the new pipeline is on.",
} as const;

/** The settings the switch writes together, in the order it writes them. */
export const mediaPipelineKeys = ["media.encode", "media.delivery"] as const;

/** What the switch shows for the stored pair: on only when both are `auto`. */
export function mediaPipelineState(
  encode: unknown,
  delivery: unknown,
): { on: boolean; partly: boolean } {
  return { on: encode === "auto" && delivery === "auto", partly: encode !== delivery };
}

/** The value both settings take when the switch turns on or off. */
export function mediaPipelineValue(on: boolean): "auto" | "legacy" {
  return on ? "auto" : "legacy";
}

/** What a refused save says, with the machine's reason when it gave one. */
export function mediaPipelineRefused(on: boolean, reason?: string): string {
  return `Couldn't turn the new media pipeline ${on ? "on" : "off"}${reason ? `: ${reason}` : "."}`;
}
