import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadId } from "@ace/protocol";
import { openHistory, type HistoryOptions, type HistoryService } from "../index.ts";
import { cwd, init, memorySink, roomySnapshots } from "../test-support.ts";
import type { parityHomes } from "./parity-fixture.ts";
import { sourceLabel, threadFor } from "./parity-normalize.ts";

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
export async function observe(
  root: string,
  homes: Awaited<ReturnType<typeof parityHomes>>,
  open: (options: HistoryOptions) => Promise<HistoryService> = openHistory,
) {
  const indexPath = join(root, "index", "index.sqlite");
  const service = await open({
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
    const labels = new Map(stored.sources.map((row) => [String(row.id), sourceLabel(root, row)]));
    for (const session of listed) {
      const label = labels.get(session.id) ?? session.id;
      const persisted = init(session.id, threadFor("persisted", label));
      const result = await attempt(() => service.importSession(persisted));
      const sink = memorySink();
      const pulled = await attempt(() =>
        service.importSession(init(session.id, threadFor("pulled", label)), sink),
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
