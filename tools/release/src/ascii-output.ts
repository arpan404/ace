import { readFile } from "node:fs/promises";

/**
 * V8 keeps every loaded script's source in memory, and one non-ASCII character makes it
 * store the whole script at two bytes per character. esbuild escapes strings but not
 * regular expression literals, so a single curly quote in a regex doubles a 3 MB chunk.
 */
export function firstNonAscii(source: string): { offset: number; excerpt: string } | undefined {
  for (let offset = 0; offset < source.length; offset++) {
    if (source.charCodeAt(offset) <= 0x7f) continue;
    return { offset, excerpt: source.slice(Math.max(0, offset - 40), offset + 20) };
  }
  return undefined;
}

/** Refuses a bundle whose scripts would be held as two-byte strings; names the escape fix. */
export async function assertAsciiScripts(paths: Iterable<string>): Promise<void> {
  for (const path of paths) {
    if (!/\.m?js$/.test(path)) continue;
    const found = firstNonAscii(await readFile(path, "utf8"));
    if (found)
      throw new Error(
        `${path} has a non-ASCII character at offset ${found.offset} (${JSON.stringify(found.excerpt)}). ` +
          "Write it as a \\u escape in the source so the daemon's code stays one byte per character.",
      );
  }
}
