import { createHash } from "node:crypto";
import { readdir, utimes } from "node:fs/promises";
import { join, relative } from "node:path";

/** One instant every fixture file is stamped with, so sizes, titles and activity are stable. */
const STAMP = new Date("2026-06-01T00:00:00.000Z");

/** Stamp every file under `root` with one modification time. */
export async function stamp(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), STAMP, STAMP);
}

type Row = Record<string, unknown>;

/** A source's label wherever the homes were made: its home, fixture-relative path and native id. */
export function sourceLabel(root: string, row: Row): string {
  return `<source ${String(row.instance)} ${relative(root, String(row.path))} ${String(row.native)}>`;
}

/** The thread an observation imports a source into, named by its label, never by list order. */
export function threadFor(kind: "persisted" | "pulled", label: string): string {
  return `${kind}-${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}
const byJson = (a: unknown, b: unknown) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};
const sessionsOf = (page: unknown) =>
  ((page as { sessions?: unknown[] }).sessions ?? []).toSorted(byJson);

/**
 * An observation of the reader over the parity homes, made comparable wherever the homes were
 * made: the fixture root, source ids (hashes of paths) and Pi references (which embed paths) are
 * written as fixture-relative labels, fingerprints (device, inode, change time) are dropped, and
 * lists whose order only breaks ties by id compare as sets.
 */
export function normalize(observation: unknown, root: string): unknown {
  let text = JSON.stringify(observation);
  const stored = (observation as { stored: { sources: Row[] } }).stored.sources;
  text = text.replaceAll(/ace-pi:([A-Za-z0-9_-]+)/g, (_all, encoded: string) => {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return `ace-pi(${decoded.replaceAll(root, "<root>").replaceAll('"', "'")})`;
  });
  for (const row of stored) text = text.replaceAll(String(row.id), sourceLabel(root, row));
  text = text.replaceAll(/"fingerprint":"[^"]*"/g, '"fingerprint":"<fingerprint>"');
  text = text.replaceAll(root, "<root>");
  const o = JSON.parse(text) as Row & {
    stored: { sources: Row[] };
    pages: unknown[];
    reads: unknown[];
    imports: { session: string }[];
    counts: unknown[];
  };
  // The crash ledger is a file of its own now (empty after these reads either way).
  const { crashes: _ledger, ...kept } = o.stored as Record<string, unknown>;
  return {
    ...o,
    stored: { ...kept, sources: o.stored.sources.toSorted(byJson) },
    pages: {
      sizes: o.pages.map((page) => sessionsOf(page).length),
      sessions: o.pages.flatMap(sessionsOf).toSorted(byJson),
    },
    openable: sessionsOf(o.openable),
    searched: sessionsOf(o.searched),
    reads: o.reads.toSorted(byJson),
    imports: o.imports.toSorted((a, b) => (a.session < b.session ? -1 : 1)),
    counts: o.counts.toSorted(byJson),
  };
}
