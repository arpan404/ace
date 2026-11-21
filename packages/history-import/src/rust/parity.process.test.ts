import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openHistory, type HistoryService } from "../index.ts";
import { cwd, init, memorySink, roomySnapshots } from "../test-support.ts";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parityHomes } from "./parity-fixture.ts";
import { normalize, parityRoot, stamp } from "./parity-normalize.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Every row the catalog keeps, in a stable order, with stored summaries parsed. */
function rows(indexPath: string) {
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all();
    return {
      sources: all("SELECT * FROM sources ORDER BY id").map((row) =>
        Object.assign(row, { summary: JSON.parse(String(row.summary)) }),
      ),
      files: all("SELECT * FROM files ORDER BY instance,path"),
      titles: all("SELECT * FROM native_titles ORDER BY instance,native"),
      crashes: all("SELECT * FROM scan_crashes"),
    };
  } finally {
    db.close();
  }
}

async function attempt<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function imported(service: HistoryService, threadId: ThreadId) {
  const thread = await service.importedThread(threadId);
  if (!thread) return null;
  const items = [];
  for (let after = 0; ;) {
    const page = await service.itemsPage({ threadId, after, limit: 50 });
    items.push(...page.items);
    if (page.next === null) break;
    after = page.next;
  }
  const blobs: Record<string, string> = {};
  for (const ref of JSON.stringify(items).matchAll(/"blobRef":"([^"]+)"/g)) {
    const id = ref[1] ?? "";
    const hash = createHash("sha256");
    for (let offset = 0; ;) {
      const chunk = await service.readBlob({ id, offset, limit: 256 * 1024 });
      hash.update(chunk.bytes);
      offset += chunk.bytes.length;
      if (offset >= chunk.size || !chunk.bytes.length) break;
    }
    blobs[id] = hash.digest("hex");
  }
  return { thread, agents: await service.importedAgents(threadId), items, blobs };
}

/** What one reader makes of the homes: its scan, lists, reads, stored rows and imports. */
async function observe(root: string, homes: Awaited<ReturnType<typeof parityHomes>>) {
  const indexPath = join(root, "rust", "index.sqlite");
  const service = await openHistory({
    indexPath,
    instances: homes.instances,
    snapshot: roomySnapshots,
  });
  try {
    const scan = await service.scan();
    const pages = [];
    for (const where of [cwd, "/elsewhere"])
      for (let before: { lastActivity: number; id: string } | undefined, n = 0; n < 50; n++) {
        const page = await service.list({
          type: "history.list",
          cwd: where,
          limit: 3,
          ...(before ? { before } : {}),
        });
        pages.push(page);
        if (!page.next) break;
        before = page.next;
      }
    const openable = await service.list({
      type: "history.list",
      cwd,
      openableOnly: true,
      limit: 200,
    });
    const searched = await service.list({
      type: "history.list",
      cwd,
      search: "RELEASE",
      limit: 200,
    });
    const stored = rows(indexPath);
    const reads = [];
    for (const source of stored.sources) reads.push(await service.get(String(source.id)));
    const imports = [];
    const listed = pages.flatMap((page) => page.sessions);
    for (const [index, session] of listed.entries()) {
      const persisted = init(session.id, `persisted-${index}`);
      const result = await attempt(() => service.importSession(persisted));
      const sink = memorySink();
      const pulled = await attempt(() =>
        service.importSession(init(session.id, `pulled-${index}`), sink),
      );
      imports.push({
        session: session.id,
        result,
        archive: await imported(service, persisted.threadId),
        pulled: {
          result: pulled,
          thread: sink.thread,
          agents: sink.agents,
          items: sink.items,
          committed: sink.committed,
        },
      });
    }
    const after = rows(indexPath);
    return {
      scan: {
        ...scan,
        unsupported: scan.unsupported.toSorted((a, b) =>
          JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
        ),
      },
      pages,
      openable,
      searched,
      stored,
      reads,
      imports,
      counts: after.sources.map((row) => row.summary),
    };
  } finally {
    await service.close();
  }
}

const expectedPath = new URL("./parity-expected.json.gz", import.meta.url);

/** What the TypeScript reader made of the parity homes, kept when it was removed (ADR 0206). */
type Observation = {
  stored: { sources: { id: unknown; instance: unknown; kind: unknown }[] };
  imports: { session: string; archive: { agents: unknown[]; blobs: object } | null }[];
};

test("ace-history stores, lists and imports the parity homes as the TypeScript reader did", async () => {
  const root = parityRoot;
  await rm(root, { recursive: true, force: true });
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
  const rust = normalize(await observe(root, homes)) as Observation & Record<string, unknown>;
  const kept = expected as Observation & Record<string, unknown>;
  for (const key of ["scan", "stored", "pages", "openable", "searched", "reads", "counts"])
    expect(rust[key], key).toEqual(kept[key]);
  for (const [index, imported] of expected.imports.entries())
    expect(rust.imports[index], imported.session).toEqual(imported);
});
