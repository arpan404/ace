import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "../store.ts";
import { transcriptQueries } from "./transcript.ts";

test("sizing one thread's transcript never reads a whole table", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-transcript-indexes-"));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const queries = store.atomic((db) => transcriptQueries(db));
    expect(queries.length).toBeGreaterThan(1);
    const scans = queries.flatMap((sql) =>
      store
        .statement(`EXPLAIN QUERY PLAN ${sql}`)
        .all("thread")
        .map((row) => String(row.detail))
        .filter((detail) => detail.startsWith("SCAN")),
    );
    expect(scans).toEqual([]);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
