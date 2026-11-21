/*
 * Settings › Beta's one switch, the new media pipeline (ADR 0147), shared by the web and the
 * phone: its words, and how `media.encode` reads as the switch. `media.delivery` is always
 * `auto` now (X3: only ace-media delivers live video), so the switch covers encoding alone, and
 * a stored `delivery` no longer counts. Pure.
 */

export const mediaPipelineSwitch = {
  title: "New media pipeline",
  description:
    "Encodes live video with ace-media on this computer's hardware; it switches at once. ace-media always delivers live video.",
  partly: "Only part of the new pipeline is on.",
} as const;

/** The settings the switch writes, in the order it writes them. */
export const mediaPipelineKeys = ["media.encode"] as const;

/**
 * What the switch shows for the stored value: on only when `media.encode` is `auto`. `partly` is
 * never true any more (delivery has no `legacy`); it stays for clients that still read it.
 */
export function mediaPipelineState(
  encode: unknown,
  _delivery?: unknown,
): {
  on: boolean;
  partly: boolean;
} {
  return { on: encode === "auto", partly: false };
}

/** The value the setting takes when the switch turns on or off. */
export function mediaPipelineValue(on: boolean): "auto" | "legacy" {
  return on ? "auto" : "legacy";
}

/** What a refused save says, with the machine's reason when it gave one. */
export function mediaPipelineRefused(on: boolean, reason?: string): string {
  return `Couldn't turn the new media pipeline ${on ? "on" : "off"}${reason ? `: ${reason}` : "."}`;
}
