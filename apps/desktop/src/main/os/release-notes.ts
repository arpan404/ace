import { isNewer } from "@ace/service/version";
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
 * What changed since `current`, from electron-updater's `releaseNotes`: one string for the
 * offered `version`, or (with `fullChangelog`) every newer release's `{ version, note }`.
 * Newest first; a stable install skips previews; releases without lines are dropped, and
 * those past the limit are counted in `olderReleases`.
 */
export function releaseNoteGroups(
  raw: unknown,
  version: string,
  current: string,
): { notes: UpdateReleaseNote[]; olderReleases: number } {
  const entries: { version: string; note: string }[] = [];
  if (typeof raw === "string") entries.push({ version, note: raw });
  else if (Array.isArray(raw)) {
    const list: unknown[] = raw;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const entryVersion: unknown = Reflect.get(entry, "version");
      const note: unknown = Reflect.get(entry, "note");
      if (typeof entryVersion === "string" && typeof note === "string")
        entries.push({ version: entryVersion, note });
    }
  }
  const preview = current.includes("-");
  const groups = entries
    .filter((entry) => preview || !entry.version.includes("-"))
    .filter((entry) => newer(entry.version, current))
    .toSorted((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0))
    .flatMap((entry) => {
      const { items, total } = releaseNoteItems(entry.note);
      return total === 0 ? [] : [{ version: entry.version, items, total }];
    });
  return {
    notes: groups.slice(0, releaseNoteLimits.releases),
    olderReleases: Math.max(0, groups.length - releaseNoteLimits.releases),
  };
}

function newer(next: string, than: string): boolean {
  try {
    return isNewer(next, than);
  } catch {
    return false;
  }
}
