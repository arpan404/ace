import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { EventPayload, ThreadId, UsageQuery } from "@ace/protocol";
import { UsageSettings } from "@ace/usage";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { createDaemonUsage } from "./usage.ts";

const at = Date.parse("2026-10-02T12:00Z");
const query = UsageQuery.parse({ from: "2026-10-01", to: "2026-10-03", groupBy: ["thread"] });

test("daemon usage recovers from a physical isolate exit without duplicating committed usage or restarting after close", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-recovery-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  const workspace = store.createWorkspace("/repo", "Repo");
  const threadId = ThreadId.parse("usage-thread");
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
  const update = (inputTokens: number) =>
    store.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens,
          outputTokens: 2,
        }),
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens: inputTokens * 10,
          outputTokens: 2,
          usageScope: "provider_session",
          counterKey: "session",
        }),
      ],
      at,
    );
  const isolates: Worker[] = [];
  const delays: { ms: number; fire(): void }[] = [];
  const errors: unknown[] = [];
  const usage = createDaemonUsage(
    home,
    store,
    UsageSettings.parse({ timezone: "UTC" }),
    (error) => errors.push(error),
    undefined,
    () => at,
    undefined,
    {
      spawn(url, options) {
        const worker = new Worker(url, options);
        isolates.push(worker);
        return worker;
      },
      delay(callback, ms) {
        const delay = { ms, fire: callback };
        delays.push(delay);
        return () => {
          const index = delays.indexOf(delay);
          if (index >= 0) delays.splice(index, 1);
        };
      },
    },
  );
  try {
    update(10);
    await usage.start();
    await usage.catchUp();
    expect((await usage.summary(query)).rows[0]?.totals.inputTokens).toBe(10);
    const physical = isolates[0];
    if (!physical) throw new Error("No isolate");
    await physical.terminate();
    update(20);
    const recovering = usage.catchUp();
    const outcome = recovering.then(
      () => "recovered",
      (error: unknown) => String(error),
    );
    // Fire the infrastructure's injected backoff, leaving idle retirement untriggered.
    const restart = delays.find((delay) => delay.ms < 5000);
    restart?.fire();
    expect(await outcome).toBe("recovered");
    expect((await usage.summary(query)).rows[0]?.totals.inputTokens).toBe(20);
    expect((await usage.series(query)).cursor).toBe(store.headSeq());
    expect(await usage.sessionTotals({ thread: threadId, limit: 100 })).toMatchObject([
      { scope: "provider_session", counterKey: "session", inputTokens: 200 },
    ]);
    const replacement = isolates.at(-1);
    if (!replacement || replacement === physical) throw new Error("No replacement");
    await replacement.terminate();
    await usage.close();
    const before = isolates.length;
    for (const delay of delays) delay.fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(isolates.length).toBe(before);
    await expect(usage.summary(query)).rejects.toThrow("closed");
  } finally {
    await usage.close().catch(() => {});
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
