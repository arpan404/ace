import { diffTexts, type DiffText } from "./diff.ts";

/*
 * Updating a skill installed from a repository (ADR 0103), in the words every client uses:
 * where it came from, whether a newer version exists, and what the update changes.
 */

/** "vercel-labs/skills · updated 23 Apr": where a skill came from and when it last changed. */
export function sourceLine(
  source: { source: string; updatedAt?: string | undefined },
  now: number,
): string {
  const at = source.updatedAt ? Date.parse(source.updatedAt) : Number.NaN;
  if (Number.isNaN(at)) return source.source;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${source.source} · updated ${date}`;
}

/** What a check for a newer version found. */
export const updateStatusText = { available: "Update available", current: "Up to date" } as const;

/** How each file in an update changes. */
export const updateChangeWords = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
} as const;

/** Said beside a file an update adds or changes that agents could run, not only read. */
export const runnableFileText = "Agents may run it";

/** "1 file changed", "3 files changed". */
export const changedFilesText = (count: number) =>
  `${count === 1 ? "1 file" : `${count} files`} changed`;

/** SKILL.md before and after an update, as a numbered diff of its lines. */
export function updateDiff(before: string, after: string): DiffText {
  const lines = diffTexts(before, after);
  return {
    lines,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
    files: ["SKILL.md"],
    numbered: true,
  };
}
