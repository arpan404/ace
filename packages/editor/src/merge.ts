import { wasm } from "./loader.ts";
import type { MergeChunk, MergeResult } from "./types.ts";

/**
 * Three-way merge by line of `mine` (the buffer) and `theirs` (the disk), both edits of `base`
 * (the text the person started from). A change only one side made lands as it is; changes both
 * sides made to the same or touching lines land once when equal and otherwise become one
 * conflict block carrying the base and both sides. Line endings come through as they were.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const flat = wasm().merge3(base, mine, theirs);
  const chunks: MergeChunk[] = [];
  let clean = true;
  for (let index = 0; index < flat.length;) {
    if (flat[index] === "conflict") {
      chunks.push({
        kind: "conflict",
        base: flat[index + 1] ?? "",
        mine: flat[index + 2] ?? "",
        theirs: flat[index + 3] ?? "",
      });
      clean = false;
      index += 4;
    } else {
      chunks.push({ kind: "clean", text: flat[index + 1] ?? "" });
      index += 2;
    }
  }
  if (!clean) return { clean, chunks };
  return {
    clean,
    text: chunks.map((chunk) => (chunk.kind === "clean" ? chunk.text : "")).join(""),
    chunks,
  };
}
