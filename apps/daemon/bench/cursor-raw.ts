// Production raw storage benchmark. Not executed before merge under owner policy.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, createDevThread } from "../src/index.ts";
import { streamSdkBody } from "@ace/adapter-cursor";
const root = await mkdtemp(join(tmpdir(), "cursor-raw-bench-")),
  store = new Store(join(root, "state.sqlite"));
const workspace = store.createWorkspace(root, "Bench"),
  thread = createDevThread(store, workspace);
const output = "line\n".repeat(209716),
  count = 20;
let chunks = 0,
  bytes = 0;
const start = performance.now();
try {
  for (let i = 0; i < count; i++) {
    const result = await streamSdkBody(
      { type: "future", index: i, output },
      `bench:${i}`,
      async (kind, body) => {
        if (kind === "blob") {
          store.atomic(() => store.appendRawChunk(thread.id, body));
          chunks++;
        }
      },
      {},
    );
    if (!result.raw) throw new Error("Missing blob");
    for (let offset = 0; offset < result.raw.size; offset += 65536)
      bytes += store.readRawChunk(result.raw.blobRef, offset, 65536).length;
  }
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      path: "sdk-shared-sqlite-raw-append-read",
      opsPerSecond: (count * 1000) / elapsed,
      microsPerOp: (elapsed * 1000) / count,
      chunks,
      bytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
