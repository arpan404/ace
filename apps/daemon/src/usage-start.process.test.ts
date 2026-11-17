import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@ace/diagnostics";
import { UsageSettings } from "@ace/usage";
import { EventPayload, ThreadId, UsageQuery } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { readConfig } from "./config.ts";
import type { startServer } from "./server.ts";
import { Resources } from "./services/resources.ts";
import { ServiceStartup, type ServiceDefinition } from "./services/startup.ts";
import { startUsage } from "./services/usage.ts";
import { Store } from "./store.ts";
import { createDaemonUsage, usageFillingBacklog } from "./usage.ts";

// Process tier: the usage projection runs in its real worker thread on a real usage.sqlite.
const at = Date.parse("2026-10-02T12:00Z");
const query = UsageQuery.parse({ from: "2026-10-01", to: "2026-10-03", groupBy: ["thread"] });
const threadId = ThreadId.parse("usage-history");
/** Usage samples in the history: many replay pages (256 events each) behind the cursor. */
const samples = 6000;
const server = {} as Awaited<ReturnType<typeof startServer>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function seedHistory(store: Store): void {
  const workspace = store.createWorkspace("/repo", "Repo");
  store.appendEvents(
    threadId,
    [
      EventPayload.parse({
        type: "thread.created",
        thread: {
          id: threadId,
          workspaceId: workspace,
          provider: "opencode",
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
          native: { provider: "opencode", id: "native" },
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
  // Incremental samples: each one adds a token, so a replayed event would show as a double count.
  for (let offset = 0; offset < samples; offset += 500)
    store.appendEvents(
      threadId,
      Array.from({ length: 500 }, () =>
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens: 1,
          outputTokens: 0,
        }),
      ),
      at,
    );
}

async function startDaemonUsage(home: string, store: Store) {
  const resources = new Resources();
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => at,
    redact: (text) => text,
    level: "silent",
  });
  const context = {
    resources,
    store,
    log,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    options: {},
    signal: new AbortController().signal,
    now: () => at,
    id: () => "id",
    services: {},
    onListen: [],
  };
  const startup = new ServiceStartup(context);
  const engine: ServiceDefinition = {
    name: "engine",
    phase: "core",
    requires: [],
    after: [],
    start() {},
  };
  const usage: ServiceDefinition = {
    name: "usage",
    phase: "listener",
    requires: [],
    after: [],
    start: startUsage,
  };
  await startup.start([engine, usage]);
  await startup.listening(server);
  const close = async () => {
    await resources.close();
    await log.close();
  };
  return {
    state: () => startup.status().find((entry) => entry.name === "usage")?.state,
    usage: () => {
      const service = Reflect.get(context.services, "usage");
      if (!service) throw new Error("Usage service was not published");
      return service as import("./services/types.ts").Services["usage"];
    },
    close,
  };
}

test("usage is ready as soon as it opens on a long history, and its totals fill in to the exact count across a restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-start-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  cleanups.push(() => store.close());
  seedHistory(store);

  const first = await startDaemonUsage(home, store);
  // Replaying the history is background work: it does not hold the service in "starting".
  expect(first.state()).toBe("ready");
  const total = async (service: ReturnType<typeof first.usage>) =>
    (await service.summary(query)).rows[0]?.totals.inputTokens ?? 0;
  await expect.poll(() => total(first.usage()), { timeout: 20_000 }).toBe(samples);
  expect((await first.usage().series(query)).cursor).toBe(store.headSeq());
  await first.close();

  // A restart resumes from the saved cursor: nothing already counted is counted again.
  const second = await startDaemonUsage(home, store);
  expect(second.state()).toBe("ready");
  await second.usage().catchUp();
  expect(await total(second.usage())).toBe(samples);
  await second.close();
});

test("while older history is still being counted, figures say so and a thread's session totals answer at once, exactly", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-filling-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  cleanups.push(() => store.close());
  seedHistory(store);
  const sessionThread = ThreadId.parse("usage-session");
  const otherThread = ThreadId.parse("usage-session-other");
  const workspace = store.createWorkspace("/session", "Session");
  for (const thread of [sessionThread, otherThread])
    store.appendEvents(
      thread,
      [
        EventPayload.parse({
          type: "thread.created",
          thread: {
            id: thread,
            workspaceId: workspace,
            provider: "codex",
            title: "Session",
            status: { state: "new" },
            createdAt: at,
            updatedAt: at,
          },
        }),
        // Inclusive snapshots grow; the total is the largest one, per key, scope and model.
        // Per-turn samples between them spread the thread over many slices of its events.
        ...[1, 3, 2].flatMap((step) => [
          ...Array.from({ length: 400 }, () =>
            EventPayload.parse({
              type: "usage.updated",
              agentId: `${thread}-root`,
              inputTokens: 1,
              outputTokens: 0,
            }),
          ),
          EventPayload.parse({
            type: "usage.updated",
            agentId: `${thread}-root`,
            inputTokens: step * (thread === sessionThread ? 100 : 7),
            outputTokens: step * 10,
            usageScope: "provider_session",
            counterKey: "session",
            model: "gpt-x",
          }),
        ]),
      ],
      at,
    );
  expect(store.headSeq()).toBeGreaterThan(usageFillingBacklog);

  // The replay is held where it is, as on a large home whose history isn't counted yet.
  let held = true;
  const usage = createDaemonUsage(
    home,
    {
      subscribeUsage: (listener) => store.subscribeUsage(listener),
      readUsagePage: (options) =>
        held ? { throughSeq: options.afterSeq, events: [] } : store.readUsagePage(options),
      headSeq: () => store.headSeq(),
      flushLiveWrites: () => store.flushLiveWrites(),
      usageReplay: store.usageReplay,
    },
    UsageSettings.parse({ timezone: "UTC" }),
    () => {},
    undefined,
    () => at,
  );
  cleanups.push(() => usage.close());
  await usage.start();

  const filling = await usage.summary(query);
  expect(filling.filling).toEqual({ through: 0, head: store.headSeq() });
  const expected = [
    {
      counterKey: "session",
      scope: "provider_session",
      model: "gpt-x",
      at,
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      costUsd: 0,
    },
  ];
  expect(await usage.sessionTotals({ thread: sessionThread, limit: 100 })).toEqual(expected);

  held = false;
  await usage.catchUp();
  expect((await usage.summary(query)).filling).toBeUndefined();
  // The counted projection agrees with the answer given before it got there.
  expect(await usage.sessionTotals({ thread: sessionThread, limit: 100 })).toEqual(expected);
});
