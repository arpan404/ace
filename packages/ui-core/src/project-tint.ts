/*
 * Which of the theme's project tints a project wears (`--project-1` to `--project-12` on the
 * web). Derived from the project's id, so it keeps its colour across renames, devices and
 * restarts, and two projects with the same name still tell apart.
 */

/** How many project tints every theme defines. */
export const projectTintCount = 12;

/** FNV-1a over the id's UTF-16 code units: stable, fast and well spread for short strings. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The project's tint, 1 to `projectTintCount`. */
export function projectTint(projectId: string): number {
  return (hash(projectId) % projectTintCount) + 1;
}
