import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { EventPayload, ThreadId, UsageQuery } from "@ace/protocol";
import { UsageSettings } from "@ace/usage";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { createDaemonUsage } from "./usage.ts";

const at = Date.parse("2026-10-02T12:00Z");
const query = UsageQuery.parse({ from: "2026-10-01", to: "2026-10-03", groupBy: ["thread"] });

test("store writes without new events leave the retired usage isolate asleep, and new usage still lands", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-idle-wake-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  const workspace = store.createWorkspace("/repo", "Repo");
  const threadId = ThreadId.parse("usage-idle-thread");
  store.appendEvents(
    threadId,
    [
      EventPayload.parse({
        type: "thread.created",
        thread: {
          id: threadId,
          workspaceId: workspace,
          provider: "codex",
          title: "Usage",
          status: { state: "new" },
          createdAt: at,
          updatedAt: at,
        },
      }),
      EventPayload.parse({
        type: "agent.created",
        agent: {
          id: "root",
          threadId,
          parentId: null,
          native: { provider: "codex", id: "native" },
          origin: "root",
          fidelity: "full",
          cwd: "/repo",
          status: { state: "idle" },
          createdAt: at,
        },
      }),
    ],
    at,
  );
  const usageUpdate = (inputTokens: number) =>
    store.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens,
          outputTokens: 1,
        }),
      ],
      at,
    );
  const isolates: Worker[] = [];
  const retirements: (() => void)[] = [];
  const usage = createDaemonUsage(
    home,
    store,
    UsageSettings.parse({ timezone: "UTC" }),
    (error) => {
      throw error;
    },
    undefined,
    () => at,
    undefined,
    {
      spawn(url, options) {
        const worker = new Worker(url, options);
        isolates.push(worker);
        return worker;
      },
      delay(callback) {
        retirements.push(callback);
        return () => {
          const index = retirements.indexOf(callback);
          if (index >= 0) retirements.splice(index, 1);
        };
      },
    },
  );
  const retire = async () => {
    for (const callback of retirements.splice(0)) callback();
    await Promise.all(isolates.map((worker) => worker.terminate()));
  };
  try {
    usageUpdate(10);
    await usage.start();
    await usage.catchUp();
    expect((await usage.summary(query)).rows[0]?.totals.inputTokens).toBe(10);
    await retire();
    const spawned = isolates.length;

    // Commits that add no events, as idle bookkeeping does, wake the replay but find nothing new.
    for (let index = 0; index < 5; index++) store.createWorkspace(`/idle-${index}`, "Idle");
    await tick();
    await usage.catchUp();
    expect(isolates.length).toBe(spawned);

    usageUpdate(25);
    await tick();
    await usage.catchUp();
    expect(isolates.length).toBe(spawned + 1);
    expect((await usage.summary(query)).rows[0]?.totals.inputTokens).toBe(25);
  } finally {
    await usage.close().catch(() => {});
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
