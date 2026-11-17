import type { UpdateReleaseNote } from "../../shared/contract.ts";

/** At most this many releases, lines per release and characters per line reach the page. */
export const releaseNoteLimits = { releases: 6, items: 8, length: 220 } as const;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
    const code =
      name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

/** GitHub's release HTML (or markdown) as plain lines, headings marked with `#`. */
function plainLines(note: string): string[] {
  const text = note
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n# ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim());
}

/**
 * One release's changes as short lines. A generated "by @someone in …/pull/985" becomes
 * "(#985)"; headings, the compare link and everything from "New Contributors" or
 * "Full Changelog" on are left out.
 */
export function releaseNoteItems(note: string): { items: string[]; total: number } {
  const items: string[] = [];
  let total = 0;
  for (const raw of plainLines(note)) {
    const heading = raw.startsWith("#");
    const plain = raw
      .replace(/^#+\s*/, "")
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ");
    const key = plain
      .toLowerCase()
      .replace(/[*_`:]/g, "")
      .trim();
    if (/^(new contributors|full changelog)\b/.test(key)) break;
    if (!plain || heading || plain.includes("/compare/")) continue;
    if (key === "what's changed" || key === "whats changed") continue;
    const line = plain.replace(
      / by @[\w-]+(?:\[bot\])? in https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g,
      " (#$1)",
    );
    total += 1;
    if (items.length < releaseNoteLimits.items)
      items.push(
        line.length <= releaseNoteLimits.length
          ? line
          : `${line.slice(0, releaseNoteLimits.length - 1).trimEnd()}…`,
      );
  }
  return { items, total };
}

/**
 * Releases' notes already in order, newest first (the release picker's order, ADR 0174), as
 * the page shows them: releases without lines are dropped, those past the limit counted.
 */
export function noteGroups(entries: readonly { version: string; note: string }[]): {
  notes: UpdateReleaseNote[];
  olderReleases: number;
} {
  const groups = entries.flatMap((entry) => {
    const { items, total } = releaseNoteItems(entry.note);
    return total === 0 ? [] : [{ version: entry.version, items, total }];
  });
  return {
    notes: groups.slice(0, releaseNoteLimits.releases),
    olderReleases: Math.max(0, groups.length - releaseNoteLimits.releases),
  };
}
