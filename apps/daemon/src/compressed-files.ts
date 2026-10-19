import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { ContentEncoding } from "./content-encoding.ts";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

interface Entry {
  version: string;
  body: Promise<Buffer>;
  /** Set once `body` resolves; only settled bodies count toward the byte bound. */
  bytes?: number;
}

async function build(file: string, encoding: ContentEncoding, size: number) {
  const raw = await readFile(file);
  const body =
    encoding === "br"
      ? await brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 9,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : await gzipped(raw);
  // A rebuild between stat and read must not be cached under the old version.
  return { body, current: raw.length === size };
}

/**
 * Compressed file bodies, built once per file version (size and mtime) and kept in memory up
 * to `maxBytes`, least recently used first out. Concurrent first requests share one build.
 */
export function compressedFiles(maxBytes: number) {
  const entries = new Map<string, Entry>();
  let total = 0;
  const drop = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    total -= entry.bytes ?? 0;
  };
  return (file: string, encoding: ContentEncoding, size: number, mtimeMs: number) => {
    const key = `${encoding}:${file}`;
    const version = `${size}:${mtimeMs}`;
    const hit = entries.get(key);
    if (hit?.version === version) {
      entries.delete(key);
      entries.set(key, hit);
      return hit.body;
    }
    if (hit) drop(key, hit);
    const built = build(file, encoding, size);
    const entry: Entry = { version, body: built.then(({ body }) => body) };
    entries.set(key, entry);
    built.then(
      ({ body, current }) => {
        if (entries.get(key) !== entry) return;
        if (!current || body.length > maxBytes) return drop(key, entry);
        entry.bytes = body.length;
        total += body.length;
        for (const [oldKey, old] of entries) {
          if (total <= maxBytes) break;
          if (old.bytes !== undefined) drop(oldKey, old);
        }
      },
      () => drop(key, entry),
    );
    return entry.body;
  };
}
