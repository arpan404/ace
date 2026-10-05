/*
 * The small badge a task row shows for its project: two letters on a tinted square. The tint is
 * derived from the project id, so a project keeps its colour across renames, devices and
 * restarts, and two projects with the same name still tell apart when their ids differ.
 */

export interface ProjectBadge {
  /** "BA" for billing-api, "AC" for ace. */
  initials: string;
  /** One of `projectBadgeHues`, as degrees on the colour wheel. */
  hue: number;
}

/** Eight hues spread around the wheel, far enough apart to tell at 16px. */
export const projectBadgeHues = [25, 70, 130, 175, 220, 265, 305, 345] as const;

/** Splits "billing-api", "ace_mobile", "docs site" and "aceMobile" into words. */
const words = (name: string): string[] =>
  name
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

export function projectInitials(name: string): string {
  const parts = words(name);
  const first = parts[0];
  if (!first) return "?";
  const second = parts[1];
  const letters = second
    ? [Array.from(first)[0], Array.from(second)[0]]
    : Array.from(first).slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}

/** FNV-1a over the id's UTF-16 code units: stable, fast and well spread for short strings. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function projectBadge(input: { id: string; name: string }): ProjectBadge {
  const hues = projectBadgeHues;
  return {
    initials: projectInitials(input.name),
    hue: hues[hash(input.id) % hues.length] ?? hues[0],
  };
}
