import { numstatRecord } from "./parse-numstat.ts";
import { z } from "zod";
import {
  count,
  decode,
  hashSchema,
  malformed,
  modeSchema,
  nul,
  pathSchema,
  Records,
} from "./decode.ts";
import type { DiffEntry } from "./types.ts";

export interface DiffFile {
  entry: DiffEntry;
  oldSha: string;
  newSha: string;
  oldMode: string;
  newMode: string;
}
const statusSchema = z.enum(["A", "M", "D", "R", "C", "T"]);
const rawSchema = z.tuple([
  modeSchema,
  modeSchema,
  hashSchema,
  hashSchema,
  z.string().regex(/^(?:[AMDT]|[RC]\d+)$/),
]);
export function parseDiff(buffer: Buffer): DiffFile[] {
  const records = new Records(nul(buffer));
  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffEntry>();
  while (records.peek()?.startsWith(":")) {
    const [oldMode, newMode, oldSha, newSha, code] = decode(
      rawSchema,
      records.next().slice(1).split(" "),
      "raw diff",
    );
    const status = decode(statusSchema, code[0], "diff status");
    if ((status === "R" || status === "C") && count(code.slice(1)) > 100)
      throw malformed("similarity score");
    const firstPath = decode(pathSchema, records.next(), "diff path");
    const renamed = status === "R" || status === "C";
    const entry: DiffEntry = {
      path: renamed ? decode(pathSchema, records.next(), "rename destination") : firstPath,
      status,
      additions: 0,
      deletions: 0,
      binary: false,
    };
    if (renamed) entry.oldPath = firstPath;
    const key = JSON.stringify([entry.oldPath ?? "", entry.path]);
    if (byPath.has(key)) throw malformed("duplicate diff path");
    byPath.set(key, entry);
    files.push({ entry, oldSha, newSha, oldMode, newMode });
  }
  const counted = new Set<string>();
  while (!records.done()) {
    const record = records.next();
    const { path, oldPath, additions, deletions, binary } = numstatRecord(record, records);
    const key = JSON.stringify([oldPath, path]);
    const entry = byPath.get(key);
    if (!entry || counted.has(key)) throw malformed("numstat path correspondence");
    counted.add(key);
    entry.binary = binary;
    entry.additions = additions;
    entry.deletions = deletions;
  }
  if (counted.size !== files.length) throw malformed("missing numstat records");
  return files;
}
