/*
 * What a row says while an agent drives something for its thread: a browser, or Mac apps.
 * Every surface that marks it (the desktop row, its hover card, the phone's row and preview)
 * uses these words, so the mark's name never differs between them.
 */

/** The browsing mark's name. */
export const browsingLabel = "An agent is browsing";

/** "Calculator", "Calculator and Notes", "Calculator, Notes and 2 more". */
export function appList(apps: readonly string[]): string {
  if (apps.length <= 2) return apps.join(" and ");
  return `${apps.slice(0, 2).join(", ")} and ${apps.length - 2} more`;
}

/** The computer-use mark's name: "An agent is using Calculator and Notes". */
export function computerUseLabel(apps: readonly string[]): string {
  return `An agent is using ${appList(apps)}`;
}
