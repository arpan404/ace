import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Agent, McpNotificationIntent, ItemId } from "@ace/protocol";
import { Store, createDevThread } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "ace-mcp-bench-"));
const store = new Store(join(dir, "events.sqlite"));
function report(name: string, count: number, start: number) {
  const ms = performance.now() - start;
  process.stdout.write(
    `${name}: ${Math.round((count * 1000) / ms)} ops/s, ${((ms * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
try {
  const thread = createDevThread(store, store.createWorkspace(dir, "Benchmark"));
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: dir,
    status: { state: "idle" },
    createdAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  for (let i = 0; i < 1000; i++)
    store.appendEvents(
      thread.id,
      [
        {
          type: "agent.created",
          agent: Agent.parse({
            ...agent,
            id: String(i).padStart(4, "0"),
            parentId: agent.id,
            origin: "ace",
          }),
        },
      ],
      1,
    );
  let start = performance.now();
  for (let i = 0; i < 10_000; i++)
    store.appendEvents(
      thread.id,
      [
        {
          type: "agent.status",
          agentId: agent.id,
          status: { state: "working", activity: "thinking" },
        },
      ],
      2,
    );
  report("persisted agent status and index", 10_000, start);
  start = performance.now();
  for (let i = 0; i < 10_000; i++) store.listMcpAgents(thread.id, "", 50);
  report("indexed page of 50 agents", 10_000, start);
  const intent = McpNotificationIntent.parse({
    type: "mcp.notify",
    sessionId: "bench",
    threadId: thread.id,
    agentId: agent.id,
    notice: { text: "Benchmark" },
  });
  start = performance.now();
  for (let i = 0; i < 5000; i++) {
    const id = String(i);
    store.enqueueMcpIntent(
      id,
      intent,
      [
        {
          type: "item.created",
          item: {
            type: "notice",
            id: ItemId.parse(`notice-${i}`),
            agentId: agent.id,
            level: "info",
            text: "Benchmark",
            complete: true,
            createdAt: 2,
            raw: [],
          },
        },
      ],
      2,
    );
    store.acknowledgeMcpIntent(id);
  }
  report("atomic notice/intent plus acknowledgement", 5000, start);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
