import { z } from "zod";
import { JsonStream } from "./json-stream.ts";
import type { Match } from "./types.ts";

const occurrence = z.object({
  line: z.number().int().positive(),
  start: z.number().int().nonnegative(),
});
/** Emit each occurrence before the event finishes, retaining a preview and Unicode bitmap. */
export function rgStream(paths: Map<string, string>, onMatch: (match: Match) => boolean) {
  let type: unknown;
  let line: unknown;
  let start: unknown;
  let path: unknown;
  let preview = "";
  let offset = 0;
  let continuations = Buffer.alloc(1024);
  return new JsonStream(
    (keys, value) => {
      const key = keys.join("/");
      if (key === "type") type = value;
      else if (key === "data/path/text") path = value;
      else if (key === "data/line_number") line = value;
      else if (key === "data/submatches/[]/start") start = value;
    },
    (keys) => {
      if (keys.join("/") === "data/submatches/[]" && type === "match") {
        const match = occurrence.parse({ line, start });
        start = undefined;
        const byte = continuations[Math.floor(match.start / 8)] ?? 0;
        if (byte & (1 << (match.start % 8))) return true;
        const file = typeof path === "string" ? paths.get(path) : undefined;
        if (!file) throw new Error("Unknown ripgrep input path");
        return onMatch({
          path: file,
          line: match.line,
          column: match.start + 1,
          preview: preview.replace(/\n$/, ""),
        });
      }
      if (!keys.length) {
        type = undefined;
        line = undefined;
        start = undefined;
        path = undefined;
      }
      return true;
    },
    (keys) => {
      if (keys.join("/") !== "data/lines/text") return undefined;
      preview = "";
      continuations.fill(0, 0, Math.ceil(offset / 8));
      offset = 0;
      return (character) => {
        if (character === null) return;
        if (preview.length < 512) preview += character.slice(0, 512 - preview.length);
        const code = character.codePointAt(0) ?? 0;
        const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        for (let next = 1; next < width; next++) {
          const position = offset + next;
          const index = Math.floor(position / 8);
          if (index >= continuations.length) {
            if (index > 6 * 1024 * 1024) throw new Error("Ripgrep line exceeds input budget");
            const grown = Buffer.alloc(Math.max(index + 1, continuations.length * 2));
            continuations.copy(grown);
            continuations = grown;
          }
          continuations[index] = (continuations[index] ?? 0) | (1 << (position % 8));
        }
        offset += width;
      };
    },
  );
}
