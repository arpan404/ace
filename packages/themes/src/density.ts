/*
 * Density: Comfortable or Compact, chosen per device. "Density is a setting, hierarchy is not":
 * Compact removes padding and spacing, never a type tier, and on a phone never a touch target,
 * which stays at least `phoneTouchTarget` tall. Pure.
 */
export const densityIds = ["comfortable", "compact"] as const;
export type DensityId = (typeof densityIds)[number];

export const densityNames: Record<DensityId, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

/** The least height of anything a finger taps, in points (Apple's Human Interface Guidelines). */
export const phoneTouchTarget = 44;

export interface PhoneDensity {
  /** A settings row's least height. */
  settingsRowHeight: number;
  /** Above and below an inbox row's two lines. */
  inboxRowPadding: number;
  /** Between an inbox row's title and its line. */
  inboxLineGap: number;
  /** What the transcript's room between blocks (8, 16 or 24 in Comfortable) is multiplied by. */
  transcriptRoom: number;
}

export const phoneDensities: Record<DensityId, PhoneDensity> = {
  comfortable: { settingsRowHeight: 56, inboxRowPadding: 12, inboxLineGap: 2, transcriptRoom: 1 },
  compact: { settingsRowHeight: 46, inboxRowPadding: 7, inboxLineGap: 1, transcriptRoom: 0.75 },
};

/**
 * An inbox row's height at the smallest Dynamic Type size, from its two lines' line heights:
 * the floor a density's padding must keep at or above a touch target.
 */
export function inboxRowHeight(density: PhoneDensity, titleLine: number, metaLine: number): number {
  return density.inboxRowPadding * 2 + titleLine + density.inboxLineGap + metaLine;
}
