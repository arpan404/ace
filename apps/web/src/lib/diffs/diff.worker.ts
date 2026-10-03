import { diffFile, type FileDiff } from "@ace/ui-core";
import { z } from "zod";
import { idbCache } from "@/lib/idb-cache.ts";
import { serveOffThread } from "@/lib/off-thread.ts";
import { FileChangesInput, decodeFileDiff } from "./diff-schema.ts";

/*
 * File diffs off the main thread (ADR 0056): an LCS per changed file, persisted in IndexedDB
 * by content key so a reload or another tab does not diff the same content again. Stored
 * diffs are decoded here, not in the page.
 */
/** About what a diff takes to store: its text as UTF-16, plus each row's numbers and kind. */
function diffBytes(diff: FileDiff): number {
  let bytes = 256;
  for (const row of diff.rows) {
    bytes += 48;
    if (row.kind !== "fold") bytes += row.text.length * 2;
    else for (const line of row.lines ?? []) bytes += 48 + line.text.length * 2;
  }
  return bytes;
}

const stored = idbCache<FileDiff>({
  name: "ace-diffs",
  maxEntries: 2_000,
  maxBytes: 128 * 1024 * 1024,
  decode: decodeFileDiff,
  weigh: diffBytes,
  now: () => Date.now(),
});
const Input = z.object({ key: z.string(), file: FileChangesInput });

serveOffThread(
  (input) => Input.parse(input),
  async ({ key, file }) => {
    const known = await stored.get(key);
    if (known) return known;
    const diff = diffFile(file);
    void stored.set(key, diff);
    return diff;
  },
);
