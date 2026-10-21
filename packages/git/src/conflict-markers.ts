import type { GitConflictHunk, GitConflictSegment } from "@ace/protocol";

const lines = /[^\n]*\n|[^\n]+$/g;
const marker = (line: string, char: string) => {
  const rest = line.slice(7);
  return line.startsWith(char.repeat(7)) && (/^[ \r\n]/.test(rest) || rest === "");
};

/**
 * Split a file Git left mid-merge into its plain text and its conflict hunks (the `merge` and
 * `diff3` styles). A marker that opens no complete hunk stays text, so a file whose markers
 * were partly edited away is never misread; joining every segment's text gives the file back.
 */
export function parseConflictMarkers(text: string): GitConflictSegment[] {
  const all = text.match(lines) ?? [];
  const segments: GitConflictSegment[] = [];
  let plain = "";
  let index = 0;
  while (index < all.length) {
    const hunk = marker(all[index] ?? "", "<") ? readHunk(all, index) : undefined;
    if (!hunk) {
      plain += all[index] ?? "";
      index++;
      continue;
    }
    if (plain) segments.push({ kind: "text", text: plain });
    plain = "";
    segments.push(hunk.hunk);
    index = hunk.next;
  }
  if (plain) segments.push({ kind: "text", text: plain });
  return segments;
}

/** Whether any complete conflict hunk is left in `text`. */
export function hasConflictHunks(text: string): boolean {
  return parseConflictMarkers(text).some((segment) => segment.kind === "conflict");
}

function readHunk(
  all: readonly string[],
  start: number,
): { hunk: GitConflictHunk; next: number } | undefined {
  const sections: string[][] = [[]];
  const found: string[] = [all[start] ?? ""];
  let phase: "ours" | "base" | "theirs" = "ours";
  for (let index = start + 1; index < all.length; index++) {
    const line = all[index] ?? "";
    if (marker(line, "<")) return undefined;
    if (phase === "ours" && marker(line, "|")) {
      phase = "base";
      found.push(line);
      sections.push([]);
    } else if (phase !== "theirs" && marker(line, "=") && line.slice(7).trim() === "") {
      if (phase === "ours") found.push("");
      phase = "theirs";
      found.push(line);
      sections.push([]);
    } else if (phase === "theirs" && marker(line, ">")) {
      const [ours = [], base = [], theirs = []] = sections;
      const [open = "", baseMarker = "", separator = ""] = found;
      const hasBase = baseMarker !== "";
      return {
        hunk: {
          kind: "conflict",
          ours: ours.join(""),
          base: hasBase ? base.join("") : null,
          theirs: (hasBase ? theirs : base).join(""),
          markers: {
            ours: open,
            base: hasBase ? baseMarker : null,
            separator,
            theirs: line,
          },
        },
        next: index + 1,
      };
    } else sections.at(-1)?.push(line);
  }
  return undefined;
}
