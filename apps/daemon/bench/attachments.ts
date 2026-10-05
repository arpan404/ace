import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ContextService } from "@ace/context";
import { createThreadState } from "@ace/core";
import { Attachment, ThreadId } from "@ace/protocol";
import { Store } from "../src/store.ts";
import { createDevThread } from "../src/commands.ts";
import { EngineRepository } from "../src/engine/repository.ts";
import { ThreadActor, systemClock } from "../src/engine/actor.ts";
import { engineLimits } from "../src/engine/limits.ts";
import { startServer } from "../src/server.ts";
import { stubHandler } from "../src/commands.ts";

// Definition only under the owner policy. Never automatically invoked by checks.
const samples = z.coerce
  .number()
  .int()
  .min(1)
  .max(10000)
  .parse(process.argv[2] ?? "100");
const root = await mkdtemp(join(tmpdir(), "ace-attachment-bench-"));
const store = new Store(join(root, "events.sqlite"));
const bytes = await readFile(
  new URL("../../../packages/context/fixtures/colours.png", import.meta.url),
);
const sha256 = createHash("sha256").update(bytes).digest("hex");
let counter = 0;
const context = await ContextService.open({
  root: join(root, "context"),
  now: () => 1000,
  id: () => `upload-${++counter}`,
  authorize: () => true,
  workspace: () => undefined,
});
const memory = () => ({
  rssMiB: process.memoryUsage().rss / 1024 ** 2,
  heapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
  peakRssMiB: process.resourceUsage().maxRSS / 1024,
});
function measure(phase: string, execute: () => void) {
  const cpu = process.cpuUsage(),
    begin = performance.now();
  for (let n = 0; n < samples; n++) execute();
  console.log(
    JSON.stringify({
      phase,
      samples,
      milliseconds: performance.now() - begin,
      cpu: process.cpuUsage(cpu),
      ...memory(),
    }),
  );
}
try {
  const thread = createDevThread(store, store.createWorkspace(root, "Images"));
  const repo = new EngineRepository(store, { next: () => `entity-${++counter}` });
  const attachment = Attachment.parse({
    sha256,
    name: "screen.png",
    mimeType: "image/png",
    bytes: bytes.length,
    width: 320,
    height: 240,
  });
  repo.attachments.remember(thread.id, 1, [attachment]);
  repo.save(
    createThreadState({ threadId: thread.id, config: { provider: "codex", silenceMs: 60000 } }),
    [],
    1000,
  );
  // Seed valid cold bodies so history sizes are comparable with a previous revision.
  for (const history of [100, 10000, 100000]) {
    store.atomic((db) => {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO engine_state_records VALUES (?, 'items', ?, ?)",
      );
      for (let n = 0; n < history; n++)
        insert.run(
          thread.id,
          `cold-${n}`,
          JSON.stringify({
            id: `cold-${n}`,
            agentId: "root",
            createdAt: 1000,
            complete: true,
            type: "message",
            role: "user",
            parts: [{ type: "text", text: "x".repeat(1024) }],
            raw: [],
            synthetic: false,
          }),
        );
    });
    measure(`actor-open-${history}-cold-items`, () => {
      const actor = new ThreadActor(
        ThreadId.parse(thread.id),
        repo,
        systemClock,
        30000,
        () => {},
        (error) => {
          throw error;
        },
        engineLimits(),
      );
      actor.stop();
    });
    measure(`indexed-attachment-${history}-cold-items`, () => {
      repo.attachments.get(thread.id, sha256);
    });
  }
  const begin = await context.uploads.handle("reader", {
    op: "upload.begin",
    threadId: thread.id,
    sha256,
    bytes: bytes.length,
    name: "screen.png",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  for (let offset = 0; offset < bytes.length; offset += 65531)
    await context.uploads.handle("reader", {
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset,
      data: bytes.subarray(offset, offset + 65531).toString("base64"),
    });
  await context.uploads.handle("reader", { op: "upload.commit", uploadId: begin.uploadId });
  const coldCpu = process.cpuUsage(),
    coldStarted = performance.now();
  await context.readAttachment("reader", thread.id, sha256, "thumbnail", 0, 65536);
  console.log(
    JSON.stringify({
      phase: "thumbnail-cold-decode",
      milliseconds: performance.now() - coldStarted,
      cpu: process.cpuUsage(coldCpu),
      ...memory(),
    }),
  );
  for (const variant of ["thumbnail", "original"] as const) {
    const cpu = process.cpuUsage(),
      readStarted = performance.now();
    for (let n = 0; n < samples; n++)
      await context.readAttachment("reader", thread.id, sha256, variant, 0, 65536);
    console.log(
      JSON.stringify({
        phase: `attachment-read-${variant}`,
        samples,
        milliseconds: performance.now() - readStarted,
        cpu: process.cpuUsage(cpu),
        ...memory(),
      }),
    );
  }
  const token = "a".repeat(64);
  const server = await startServer({
    port: 0,
    token,
    hostId: "bench",
    store,
    context,
    handler: stubHandler({ development: true }),
  });
  try {
    for (const variant of ["thumbnail", "original"] as const) {
      const cpu = process.cpuUsage(),
        httpStarted = performance.now();
      let transferred = 0;
      for (let n = 0; n < samples; n++) {
        const response = await fetch(
          `${server.httpUrl}/v1/attachments/${thread.id}/${sha256}/${variant}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (response.status !== 200) throw new Error(`Attachment HTTP status ${response.status}`);
        transferred += (await response.arrayBuffer()).byteLength;
      }
      const elapsed = performance.now() - httpStarted;
      console.log(
        JSON.stringify({
          phase: `http-${variant}`,
          samples,
          milliseconds: elapsed,
          MiBPerSecond: transferred / 1024 ** 2 / (elapsed / 1000),
          cpu: process.cpuUsage(cpu),
          ...memory(),
        }),
      );
    }
  } finally {
    await server.close();
  }
} finally {
  await context.close();
  await store.close();
  await rm(root, { recursive: true, force: true });
}
