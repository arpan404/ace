/*
 * Transcript size: the reading text's size, chosen per device. Web draws it at these pixel sizes;
 * phones scale their Dynamic Type size by the same ratio to the default, so the choice still
 * follows the system's text size.
 */
export const transcriptSizeIds = ["small", "default", "large"] as const;
export type TranscriptSizeId = (typeof transcriptSizeIds)[number];

export const transcriptSizes: Record<TranscriptSizeId, { px: number; label: string }> = {
  small: { px: 14, label: "Small" },
  default: { px: 15, label: "Default" },
  large: { px: 17, label: "Large" },
};

/** The size relative to the default: what phones multiply their Dynamic Type size by. */
export function transcriptScale(id: TranscriptSizeId): number {
  return transcriptSizes[id].px / transcriptSizes.default.px;
}
