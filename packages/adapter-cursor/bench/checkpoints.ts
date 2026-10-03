// Non-gating. Not executed under the owner's merge-only validation rule.
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorJournal, openSdkCheckpointStore } from "../src/index.ts";
import { JsonlLocalAgentStore } from "@cursor/sdk";

const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-checkpoint-bench-")));
let owned: Awaited<ReturnType<typeof openSdkCheckpointStore>> | undefined;
const report = (path: string, count: number, elapsed: number) =>
  console.log(
    JSON.stringify({
      path,
      opsPerSecond: (count * 1000) / elapsed,
      microsPerOp: (elapsed * 1000) / count,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
try {
  const journal = new CursorJournal(root, 8_388_608, 4096);
  await journal.recover(0, async () => {});
  let start = performance.now();
  for (let i = 0; i < 1000; i++)
    await journal.append({
      schemaVersion: 1,
      generation: "bench",
      operationId: "operation",
      segment: 0,
      kind: "delta",
      body: { type: "text-delta", text: "delta" },
    });
  report("sdk-boundary-journal-fsync", 1000, performance.now() - start);
  let replayed = 0;
  start = performance.now();
  await new CursorJournal(root, 8_388_608, 4096).recover(0, async () => {
    replayed++;
  });
  report("sdk-boundary-journal-recovery", replayed, performance.now() - start);
  owned = await openSdkCheckpointStore({ JsonlLocalAgentStore }, root, root);
  const agent = {
    agentId: "agent-bench",
    cwd: root,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  } as const;
  await owned.store.agents.create({ agent });
  start = performance.now();
  for (let i = 0; i < 1000; i++)
    await owned.store.agents.update({ agent: { ...agent, updatedAt: i + 1 } });
  report("sdk-native-sqlite-checkpoint-metadata", 1000, performance.now() - start);
} finally {
  await owned?.close();
  await rm(root, { recursive: true, force: true });
}
