import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { openHistory } from "../src/index.ts";
const root = await mkdtemp(join(tmpdir(), "ace-history-tools-bench-"));
let history;
try {
  const home = join(root, "codex");
  await mkdir(join(home, "sessions/2026/01/01"), { recursive: true });
  const file = createWriteStream(join(home, "sessions/2026/01/01/rollout.jsonl"));
  file.write(
    JSON.stringify({
      type: "session_meta",
      payload: { id: "11111111-1111-4111-8111-111111111111", cwd: "/bench" },
    }) + "\n",
  );
  for (let i = 0; i < 2000; i++) {
    for (const payload of [
      {
        type: "function_call",
        call_id: String(i),
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
      { type: "function_call_output", call_id: String(i), output: "x".repeat(4096) },
    ])
      if (!file.write(JSON.stringify({ type: "response_item", payload }) + "\n"))
        await once(file, "drain");
  }
  file.end();
  await once(file, "finish");
  history = await openHistory({
    indexPath: join(root, "ace/index.sqlite"),
    instances: [{ id: "account", provider: "codex", homeDir: home }],
  });
  await history.scan();
  const source = (await history.list({ type: "history.list", cwd: "/bench" })).sessions[0];
  if (!source) throw new Error("Missing source");
  const start = performance.now();
  await history.importSession({
    sourceId: source.id,
    threadId: ThreadId.parse("tools"),
    workspaceId: WorkspaceId.parse("workspace"),
    agentId: "root",
    at: 0,
  });
  const ms = performance.now() - start;
  console.log(
    JSON.stringify({
      benchmark: "2000-correlated-calls-and-outputs",
      ms,
      callsPerSecond: 2000 / (ms / 1000),
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  await history?.close();
  await rm(root, { recursive: true, force: true });
}
