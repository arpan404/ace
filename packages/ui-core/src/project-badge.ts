/*
 * The small badge a task row shows for its project: two letters on a tinted square. The tint is
 * one of the theme's project tints (`--project-1` to `--project-12` on the web), derived from the
 * project id, so a project keeps its colour across renames, devices and restarts, and two
 * projects with the same name still tell apart when their ids differ.
 */

export interface ProjectBadge {
  /** "BA" for billing-api, "AC" for ace. */
  initials: string;
  /** The project's tint, 1 to `projectTintCount` (`projectTint`). */
  tint: number;
}

/** How many project tints every theme defines. */
export const projectTintCount = 12;

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

/** The project's tint, 1 to `projectTintCount`: the same for an id on every device and release. */
export function projectTint(projectId: string): number {
  return (hash(projectId) % projectTintCount) + 1;
}

export function projectBadge(input: { id: string; name: string }): ProjectBadge {
  return { initials: projectInitials(input.name), tint: projectTint(input.id) };
}

/** A UUID, or a long run of hex: an id a person never chose and can't tell apart from another. */
const opaqueId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;

/** What a project reads as when nothing names it yet (loading, or a removed project). */
export const unnamedProject = "Project";

/**
 * A project as people know it: the name the daemon gave it, else its folder's name, else its id
 * when that reads as a name ("ace"), else "Project". An opaque id (a UUID) never shows.
 */
export function projectLabel(
  id: string,
  known?: { name?: string | undefined; path?: string | undefined },
): string {
  const name = known?.name?.trim();
  if (name) return name;
  const folder = known?.path?.split(/[\\/]/).findLast(Boolean);
  if (folder) return folder;
  return id && !opaqueId.test(id) ? id : unnamedProject;
}

/** Every pair a name can offer, best first: its own initials, then the next distinct ones. */
function initialsCandidates(name: string): string[] {
  const parts = words(name).map((word) => Array.from(word));
  const first = parts[0];
  if (!first) return ["?"];
  const lead = first[0] ?? "";
  const pairs = [
    projectInitials(name),
    // Letters from different words first: the first word's initial with each other word's
    // letters, then the first word's own later letters.
    ...parts.slice(1).map((word) => lead + (word[0] ?? "")),
    ...parts.slice(1).flatMap((word) => word.slice(1).map((letter) => lead + letter)),
    ...first.slice(1).map((letter) => lead + letter),
  ];
  return [...new Set(pairs.map((pair) => pair.toLocaleUpperCase()))];
}

/**
 * Initials for a list of projects shown together, so no two share a mark: each takes its own
 * initials unless an earlier one already holds them, then the next pair its name offers. When a
 * name runs out of pairs it keeps its own. Order decides who keeps the plain initials.
 */
export function distinctInitials(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const options = initialsCandidates(name);
    const pick = options.find((pair) => !taken.has(pair)) ?? options[0] ?? "?";
    taken.add(pick);
    return pick;
  });
}
