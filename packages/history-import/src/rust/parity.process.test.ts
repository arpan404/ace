import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { parityHomes } from "./parity-fixture.ts";
import { normalize, stamp } from "./parity-normalize.ts";
import { observe } from "./parity-observe.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const expectedPath = new URL("./parity-expected.json.gz", import.meta.url);

/** What the TypeScript reader made of the parity homes, kept when it was removed (ADR 0207). */
type Observation = {
  stored: { sources: { id: unknown; instance: unknown; kind: unknown }[] };
  imports: { session: string; archive: { agents: unknown[]; blobs: object } | null }[];
};

test("ace-history stores, lists and imports the parity homes as the TypeScript reader did", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-parity-"));
  roots.push(root);
  const homes = await parityHomes(join(root, "homes"));
  await stamp(join(root, "homes"));
  const expected = JSON.parse(
    gunzipSync(await readFile(expectedPath)).toString("utf8"),
  ) as Observation;
  // The kept observation exercises what it means to: every provider's homes listed and imported,
  // subagents and blobs.
  expect(expected.stored.sources.length).toBeGreaterThan(homes.recorded);
  expect(expected.imports.some((i) => (i.archive?.agents.length ?? 0) > 1)).toBe(true);
  expect(expected.imports.some((i) => Object.keys(i.archive?.blobs ?? {}).length > 1)).toBe(true);
  const kinds = new Set(
    expected.stored.sources.map((row) => `${String(row.instance)}:${String(row.kind)}`),
  );
  for (const kind of [
    "opencode-storage:storage",
    "opencode-v1:database",
    "opencode-v2:database",
    "pi-home:jsonl",
  ])
    expect(kinds).toContain(kind);
  for (const instance of ["opencode-storage", "opencode-v1", "opencode-v2", "pi-home"])
    expect(
      expected.imports.filter(
        (i) =>
          i.archive !== null &&
          expected.stored.sources.some((row) => row.id === i.session && row.instance === instance),
      ).length,
      instance,
    ).toBeGreaterThan(0);
  const rust = normalize(await observe(root, homes), root) as Observation & Record<string, unknown>;
  const kept = expected as Observation & Record<string, unknown>;
  for (const key of ["scan", "stored", "pages", "openable", "searched", "reads", "counts"])
    expect(rust[key], key).toEqual(kept[key]);
  for (const [index, one] of expected.imports.entries())
    expect(rust.imports[index], one.session).toEqual(one);
});
