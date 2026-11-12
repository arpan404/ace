/*
 * Month labels under the activity grid: a narrow grid has no room for one over every month, so
 * the labels that would overlap or run off the right edge are left out. Pure: positions and
 * widths are CSS px, and the container is the strip the labels sit in.
 */

/** A month label below the grid: its left edge and drawn width, in CSS px. */
export interface MonthLabel {
  label: string;
  x: number;
  width: number;
}

/** The labels are `text-xs`; a UI sans averages about 0.6em wide per character. */
const labelSize = 12;
const characterWidth = 0.6;

/** The clear space kept between two labels that both show. */
export const monthLabelGap = 6;

/** An estimate of a month label's drawn width in CSS px. */
export function monthLabelWidth(label: string): number {
  return Math.round(label.length * labelSize * characterWidth);
}

/**
 * The labels that fit across `containerWidth`: one starting closer than `gap` after the label
 * shown before it ends would touch it, and one running past the right edge would overflow, so
 * both are skipped.
 */
export function visibleMonthLabels<T extends MonthLabel>(
  labels: readonly T[],
  containerWidth: number,
  gap: number,
): T[] {
  const shown: T[] = [];
  let endsAt = -Infinity;
  for (const label of labels) {
    if (label.x + label.width > containerWidth) continue;
    if (label.x < endsAt + gap) continue;
    shown.push(label);
    endsAt = label.x + label.width;
  }
  return shown;
}
