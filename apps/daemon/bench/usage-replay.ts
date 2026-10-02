import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventPayload, ThreadId } from "@ace/protocol";
import { Store } from "../src/store.ts";

// Non-gating: compact replay with a multi-megabyte title/cwd and large selected models.
const home = mkdtempSync(join(tmpdir(), "ace-replay-bench-"));
const store = new Store(join(home, "events.sqlite"));
try {
  const at = Date.parse("2026-10-02T12:00Z");
  const workspaceId = store.createWorkspace("/bench", "Bench", at);
  const threadId = ThreadId.parse("thread");
  const privateText = "x".repeat(2 * 1024 * 1024);
  store.appendEvents(
    threadId,
    [
      EventPayload.parse({
        type: "thread.created",
        thread: {
          id: threadId,
          workspaceId,
          provider: "codex",
          title: privateText,
          status: { state: "new" },
          createdAt: at,
          updatedAt: at,
        },
      }),
    ],
    at,
  );
  store.appendEvents(
    threadId,
    [
      EventPayload.parse({
        type: "agent.created",
        agent: {
          id: "agent",
          threadId,
          parentId: null,
          native: { provider: "codex" },
          origin: "root",
          fidelity: "full",
          cwd: privateText,
          model: "m",
          status: { state: "idle" },
          createdAt: at,
        },
      }),
    ],
    at,
  );
  for (let i = 0; i < 1000; i++)
    store.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "agent.updated",
          agentId: "agent",
          model: "m".repeat(8000),
        }),
      ],
      at,
    );
  const start = performance.now();
  let cursor = 0;
  let pages = 0;
  let events = 0;
  let largestPage = 0;
  while (cursor < store.headSeq()) {
    const page = store.readUsagePage({ afterSeq: cursor, limit: 256 });
    cursor = page.throughSeq;
    events += page.events.length;
    pages++;
    largestPage = Math.max(largestPage, Buffer.byteLength(JSON.stringify(page.events)));
  }
  const elapsed = performance.now() - start;
  process.stdout.write(
    `replay=${Math.round((events * 1000) / elapsed)} events/s, ${((elapsed * 1000) / events).toFixed(2)} us/event, pages=${pages}, largest=${largestPage} bytes\n`,
  );
  process.stdout.write(`peak RSS=${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`);
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
