import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { openHistory, type ImportSink } from "../src/index.ts";
import { ThreadId, WorkspaceId } from "@ace/protocol";

const root = await mkdtemp(join(tmpdir(), "ace-history-bench-"));
const home = join(root, "provider"),
  project = join(home, "projects/p");
await mkdir(project, { recursive: true });
let service;
try {
  for (let batch = 0; batch < 5000; batch += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, 5000 - batch) }, async (_, offset) => {
        const id = `session-${batch + offset}`;
        await writeFile(
          join(project, id + ".jsonl"),
          JSON.stringify({
            type: "user",
            sessionId: id,
            cwd: "/workspace",
            message: { role: "user", content: "benchmark prompt" },
          }) + "\n",
        );
      }),
    );
  service = await openHistory({
    indexPath: join(root, "ace/index.sqlite"),
    instances: [{ id: "home", provider: "claude", homeDir: home }],
  });
  for (const label of ["cold", "warm"]) {
    const started = performance.now();
    const scan = await service.scan();
    const ms = performance.now() - started;
    console.log(
      JSON.stringify({
        benchmark: `5000-file-${label}`,
        ms,
        filesPerSecond: 5000 / (ms / 1000),
        ...scan,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
  const large = join(project, "large.jsonl");
  const stream = createWriteStream(large);
  for (let i = 0; i < 20_000; i++) {
    const line =
      JSON.stringify({
        type: "user",
        sessionId: "large",
        cwd: "/large",
        message: { role: "user", content: "x".repeat(1024) },
      }) + "\n";
    if (!stream.write(line)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd: "/large" })).sessions[0];
  if (!source) throw new Error("Missing large session");
  let items = 0;
  const sink: ImportSink = {
    async begin() {},
    async appendAgent() {},
    async appendItem() {
      items++;
    },
    async beginBlob() {},
    async appendBlob() {},
    async endBlob() {},
    async commit() {},
    async rollback() {},
  };
  const started = performance.now();
  await service.importSession(
    {
      sourceId: source.id,
      threadId: ThreadId.parse("bench"),
      workspaceId: WorkspaceId.parse("bench"),
      agentId: "bench",
      at: 0,
    },
    sink,
  );
  const ms = performance.now() - started;
  console.log(
    JSON.stringify({
      benchmark: "20000-message-import",
      ms,
      items,
      itemsPerSecond: items / (ms / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
  const persistedStarted = performance.now();
  await service.importSession({
    sourceId: source.id,
    threadId: ThreadId.parse("persisted-bench"),
    workspaceId: WorkspaceId.parse("bench"),
    agentId: "persisted-bench",
    at: 0,
  });
  const persistedMs = performance.now() - persistedStarted;
  console.log(
    JSON.stringify({
      benchmark: "20000-message-persisted-import",
      ms: persistedMs,
      itemsPerSecond: 20000 / (persistedMs / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
  const pagesStarted = performance.now();
  for (let i = 0; i < 100; i++)
    await service.itemsPage({
      threadId: ThreadId.parse("persisted-bench"),
      limit: 200,
      after: i * 200,
    });
  const pagesMs = performance.now() - pagesStarted;
  console.log(
    JSON.stringify({
      benchmark: "100-history-pages",
      ms: pagesMs,
      pagesPerSecond: 100 / (pagesMs / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  await service?.close();
  await rm(root, { recursive: true, force: true });
}
