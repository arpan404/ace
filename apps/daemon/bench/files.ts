import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store, createDevThread } from "../src/index.ts";

const home = await mkdtemp(join(tmpdir(), "ace-files-fanout-bench-"));
const store = new Store(join(home, "events.sqlite"));
try {
  const workspace = store.createWorkspace(home, "Bench");
  for (let i = 0; i < 256; i++) createDevThread(store, workspace, `Thread ${i}`);
  const started = performance.now();
  const changes = 100;
  for (let i = 0; i < changes; i++)
    store.recordWorkspaceFileChange(workspace, {
      id: `change-${i}`,
      op: "write",
      path: "file",
      version: `v${i}`,
    });
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(
    JSON.stringify({
      changesPerSecond: changes / seconds,
      threadEventsPerSecond: (changes * 256) / seconds,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }) + "\n",
  );
} finally {
  store.close();
  await rm(home, { recursive: true, force: true });
}
