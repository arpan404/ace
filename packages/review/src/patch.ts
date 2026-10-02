import { z } from "zod";
import type { DiffResult } from "@ace/git";
import { ReviewPath } from "@ace/protocol";

const count = z.number().int().min(0).max(10_000_000);

export interface Change {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}
export interface Hunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
  changes: Change[];
}
export interface PatchFile {
  path: string;
  oldPath: string;
  hunks: Hunk[];
  unavailable: boolean;
}

/** Git's core.quotePath=true spelling; paths come from its typed metadata. */
export function quotePath(path: string): string {
  const bytes = Buffer.from(path);
  if (bytes.every((byte) => byte >= 32 && byte < 127 && byte !== 34 && byte !== 92)) return path;
  return (
    '"' +
    [...bytes]
      .map((byte) =>
        byte === 34
          ? '\\"'
          : byte === 92
            ? "\\\\"
            : byte >= 32 && byte < 127
              ? String.fromCharCode(byte)
              : "\\" + byte.toString(8).padStart(3, "0"),
      )
      .join("") +
    '"'
  );
}

export function readPatch(diff: DiffResult): PatchFile[] {
  if (diff.truncated || Buffer.byteLength(diff.patch) > 1024 * 1024)
    throw new Error("review_diff_too_large");
  const paths = new Map(
    diff.entries.filter((e) => !e.binary).map((e) => [quotePath("b/" + e.path), e]),
  );
  const oldPaths = new Map(
    diff.entries.filter((e) => !e.binary).map((e) => [quotePath("a/" + (e.oldPath ?? e.path)), e]),
  );
  const files: PatchFile[] = diff.entries.map((entry) => ({
    path: ReviewPath.parse(entry.path),
    oldPath: ReviewPath.parse(entry.oldPath ?? entry.path),
    hunks: [],
    unavailable: entry.binary || entry.status === "D",
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  let file: PatchFile | undefined;
  let oldHeader = "";
  let hunk: Hunk | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of diff.patch.split("\n")) {
    if (oldRemaining || newRemaining) {
      if (!hunk) throw new Error("review_invalid_patch");
      if (line.startsWith("\\")) continue;
      const kind = line[0];
      if (kind === "-" || kind === "+") {
        let change = hunk.changes.at(-1);
        const oldLine = hunk.oldStart + hunk.oldLines.length;
        const newLine = hunk.newStart + hunk.newLines.length;
        if (
          !change ||
          change.oldStart + change.oldCount !== oldLine ||
          change.newStart + change.newCount !== newLine
        ) {
          change = { oldStart: oldLine, newStart: newLine, oldCount: 0, newCount: 0 };
          hunk.changes.push(change);
        }
        if (kind === "-") change.oldCount++;
        else change.newCount++;
      }
      if (kind === " " || kind === "-") {
        hunk.oldLines.push(line.slice(1));
        oldRemaining--;
      }
      if (kind === " " || kind === "+") {
        hunk.newLines.push(line.slice(1));
        newRemaining--;
      }
      if ((kind !== " " && kind !== "-" && kind !== "+") || oldRemaining < 0 || newRemaining < 0)
        throw new Error("review_invalid_patch");
      continue;
    }
    if (line.startsWith("--- ")) {
      oldHeader = line.slice(4).replace(/\t$/, "");
      file = undefined;
    } else if (line.startsWith("+++ ")) {
      const entry =
        line.slice(4) === "/dev/null"
          ? oldPaths.get(oldHeader)
          : paths.get(line.slice(4).replace(/\t$/, ""));
      if (!entry) throw new Error("review_invalid_patch");
      file = byPath.get(entry.path);
      if (!file) throw new Error("review_invalid_patch");
    } else if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match || !file) throw new Error("review_invalid_patch");
      oldRemaining = count.parse(Number(match[2] ?? 1));
      newRemaining = count.parse(Number(match[4] ?? 1));
      hunk = {
        oldStart: count.parse(Number(match[1])) + (oldRemaining === 0 ? 1 : 0),
        newStart: count.parse(Number(match[3])) + (newRemaining === 0 ? 1 : 0),
        oldLines: [],
        newLines: [],
        changes: [],
      };
      file.hunks.push(hunk);
    }
  }
  if (oldRemaining || newRemaining) throw new Error("review_invalid_patch");
  return files;
}
