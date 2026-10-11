import { LruCache } from "@ace/ui-core";
import { z } from "zod";
import { serveOffThread } from "@/lib/off-thread.ts";
import { searchLines } from "./find-hits.ts";
const Input = z.object({ hash: z.string(), query: z.string(), text: z.string().optional() });
const sources = new LruCache<string, string[]>({
  maxEntries: 4,
  maxWeight: 8 * 1024 * 1024,
  weigh: (lines) => lines.reduce((bytes, line) => bytes + 16 + line.length * 2, 0),
});
serveOffThread(
  (input) => Input.parse(input),
  (input) => {
    const lines =
      input.text === undefined ? sources.get(input.hash) : input.text.toLowerCase().split("\n");
    if (!lines) return null;
    if (input.text !== undefined) sources.set(input.hash, lines);
    return searchLines(lines, input.query);
  },
);
