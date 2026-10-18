/**
 * Page zoom steps, as a browser offers them. The daemon keeps each tab's zoom (a factor of 1
 * for 100%); these pick the next step either way.
 */
export const zoomLevels = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The next step up, or the largest; a factor between steps goes to the step above it. */
export function zoomIn(current: number): number {
  return zoomLevels.find((level) => level > current && !near(level, current)) ?? 5;
}

/** The next step down, or the smallest. */
export function zoomOut(current: number): number {
  return zoomLevels.findLast((level) => level < current && !near(level, current)) ?? 0.25;
}

/** "110%" */
export function zoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** The zoom a key means: ⌘= or ⌘+ in, ⌘- out, ⌘0 back to 100%. */
export function zoomForKey(key: string, current: number): number | undefined {
  if (key === "=" || key === "+") return zoomIn(current);
  if (key === "-" || key === "_") return zoomOut(current);
  if (key === "0") return 1;
  return undefined;
}
