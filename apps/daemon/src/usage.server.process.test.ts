import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UsageQuery, EventPayload, AgentId, ItemId } from "@ace/protocol";
import { UsageSettings } from "@ace/usage";
import { createDaemonUsage, loadUsageSettings, type UsageCommands } from "./usage.ts";
import { setup, cleanups } from "./remote-test-support.ts";

const query = UsageQuery.parse({ from: "2026-01-01", to: "2026-12-31" });
async function analyticsFixture() {
  let usage: ReturnType<typeof createDaemonUsage> | undefined;
  const port: UsageCommands = {
    async summary(q) {
      if (!usage) throw new Error("Missing usage service");
      return usage.summary(q);
    },
    async series(q) {
      if (!usage) throw new Error("Missing usage service");
      return usage.series(q);
    },
    async sessionTotals(q) {
      if (!usage) throw new Error("Missing usage service");
      return usage.sessionTotals(q);
    },
  };
  const f = await setup({ usage: port });
  const service = createDaemonUsage(
    f.home,
    f.store,
    UsageSettings.parse({ timezone: "UTC" }),
    (error) => {
      throw error;
    },
    {
      async windows() {
        return [
          {
            id: "window",
            unit: "tokens",
            start: Date.parse("2026-10-02"),
            end: Date.parse("2026-10-03"),
            remaining: 100,
          },
        ];
      },
    },
    () => Date.parse("2026-10-02T02:00Z"),
  );
  usage = service;
  cleanups.push(() => service.close());
  await service.start();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: {
          id: "root",
          threadId: f.thread.id,
          parentId: null,
          origin: "root",
          native: { provider: "codex" },
          fidelity: "full",
          model: "claude-sonnet-4-6",
          cwd: "/repo",
          status: { state: "idle" },
          background: false,
          createdAt: 1,
        },
      },
    ].map((payload) => EventPayload.parse(payload)),
    Date.parse("2026-10-02T00:00Z"),
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "usage.updated",
        agentId: AgentId.parse("root"),
        inputTokens: 12,
        outputTokens: 3,
        accountId: "acc",
        billingMode: "subscription",
      },
    ],
    Date.parse("2026-10-02T01:00Z"),
  );
  await service.catchUp();
  return { ...f, service };
}

it("authenticated read commands return stored usage, daily series and account burn rate", async () => {
  const f = await analyticsFixture();
  const device = await f.pair(["read"]);
  const ticket = await f.ticket(device.token);
  const client = await f.connectTicket(device.device.id, ticket.ticket);
  expect((await client.next()).type).toBe("welcome");
  client.send({
    type: "usage.summary",
    requestId: "summary",
    query: { ...query, quotaAccount: "acc" },
  });
  expect(await client.next()).toMatchObject({
    type: "usage.result",
    requestId: "summary",
    kind: "summary",
    result: {
      cursor: f.store.headSeq(),
      rows: [
        {
          totals: {
            inputTokens: 12,
            outputTokens: 3,
            providerReportedUsd: 0,
            subscriptionTokens: 15,
          },
        },
      ],
      burn: [{ observed: 15, perHour: 7.5 }],
    },
  });
  client.send({ type: "usage.series", requestId: "series", query });
  expect(await client.next()).toMatchObject({
    type: "usage.result",
    requestId: "series",
    kind: "series",
    result: { rows: [{ dimensions: { day: "2026-10-02" } }] },
  });
});
it("operate-only devices cannot read analytics and malformed queries are rejected on the wire", async () => {
  const f = await analyticsFixture();
  const device = await f.pair(["operate"]);
  const ticket = await f.ticket(device.token);
  const client = await f.connectTicket(device.device.id, ticket.ticket);
  await client.next();
  client.send({ type: "usage.summary", requestId: "denied", query });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
  const host = await f.connect();
  await host.next();
  host.socket.send(
    JSON.stringify({
      type: "usage.series",
      requestId: "invalid",
      query: { ...query, groupBy: ["sql"] },
    }),
  );
  expect(await host.next()).toMatchObject({ type: "error", code: "invalid_message" });
});
it("daemon backfill advances through output-only pages and settings overrides revalue history", async () => {
  const f = await analyticsFixture();
  const before = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 256 }, () => ({
      type: "item.delta" as const,
      itemId: ItemId.parse("i"),
      agentId: AgentId.parse("root"),
      field: "text" as const,
      append: "transcript content",
    })),
  );
  const page = f.store.readUsagePage({ afterSeq: before, limit: 256 });
  expect(page).toEqual({ events: [], throughSeq: before + 256 });
  await f.service.catchUp();
  expect((await f.service.summary(query)).cursor).toBe(before + 256);
  writeFileSync(
    join(f.home, "usage-settings.json"),
    JSON.stringify({
      timezone: "America/Chicago",
      overrideVersion: "negotiated",
      priceOverrides: {
        "claude-sonnet-4-6": { input: 1, output: 5, cached: 0, write: 1, write1h: 2 },
      },
    }),
  );
  const settings = await loadUsageSettings(f.home);
  expect(settings.timezone).toBe("America/Chicago");
  expect(settings.priceOverrides["claude-sonnet-4-6"]?.input).toBe(1);
  const q = UsageQuery.parse({ ...query, equivalentApiCost: true });
  expect((await f.service.summary(q)).rows[0]?.totals.equivalentApiUsd).toBeCloseTo(0.000081);
  await f.service.close();
  // Keep the projection timezone; pricing alone can change without rebuilding history.
  writeFileSync(
    join(f.home, "usage-settings.json"),
    JSON.stringify({ ...settings, timezone: "UTC" }),
  );
  const reopened = createDaemonUsage(f.home, f.store, await loadUsageSettings(f.home), (error) => {
    throw error;
  });
  cleanups.push(() => reopened.close());
  await reopened.start();
  const repriced = await reopened.summary(q);
  expect(repriced.rows[0]?.totals.equivalentApiUsd).toBeCloseTo(0.000027);
  expect(repriced.rows[0]?.totals.inputTokens).toBe(12);
  expect(repriced.priceVersion).toContain("negotiated");
  writeFileSync(join(f.home, "usage-settings.json"), JSON.stringify({ timezone: "Mars/Orbit" }));
  await expect(loadUsageSettings(f.home)).rejects.toThrow();
});

it("inclusive snapshot reads use the daemon worker and require thread read authority", async () => {
  const f = await analyticsFixture();
  f.store.appendEvents(f.thread.id, [
    EventPayload.parse({
      type: "usage.updated",
      agentId: "root",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 3,
      usageScope: "provider_session",
      counterKey: "native:initial",
    }),
  ]);
  const client = await f.connect();
  await client.next();
  client.send({
    type: "usage.session_totals",
    requestId: "inclusive",
    query: { thread: f.thread.id, limit: 100 },
  });
  expect(await client.next()).toMatchObject({
    type: "usage.session_totals.result",
    requestId: "inclusive",
    totals: [
      { scope: "provider_session", counterKey: "native:initial", inputTokens: 100, costUsd: 3 },
    ],
  });
  expect((await f.service.summary(query)).rows[0]?.totals.inputTokens).toBe(12);
  const device = await f.pair(["operate"]);
  const ticket = await f.ticket(device.token);
  const restricted = await f.connectTicket(device.device.id, ticket.ticket);
  await restricted.next();
  restricted.send({
    type: "usage.session_totals",
    requestId: "denied",
    query: { thread: f.thread.id, limit: 100 },
  });
  expect(await restricted.next()).toMatchObject({ type: "error", code: "forbidden" });
});
