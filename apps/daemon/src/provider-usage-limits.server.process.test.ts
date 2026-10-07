import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { EventPayload, UsageQuery } from "@ace/protocol";
import { UsageSettings } from "@ace/usage";
import { createDaemonUsage, type UsageCommands } from "./usage.ts";
import { setup, cleanups } from "./remote-test-support.ts";

it("provider reads combine per-account costs with limits and push changes only to readers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-usage-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  cleanups.push(() => registry.close());
  const now = Date.parse("2026-10-02T12:00Z");
  for (const [id, provider] of [
    ["api", "codex"],
    ["other", "claude"],
  ] as const)
    await registry.register(createInstance({ id, provider, label: id, homeDir: join(home, id) }));
  registry.ingest("api", {
    provider: "codex",
    observedAt: now,
    timeZone: "UTC",
    payload: new ProviderPayload(JSON.stringify({ auth: "logged_in", authDetail: "API key" })),
  });
  const accounts = new AccountService({ registry, now: () => now, timeZone: "UTC", env: {} });
  let usage: ReturnType<typeof createDaemonUsage> | undefined;
  const port: UsageCommands = {
    summary: (q) => {
      if (!usage) throw new Error("Missing usage");
      return usage.summary(q);
    },
    series: (q) => {
      if (!usage) throw new Error("Missing usage");
      return usage.series(q);
    },
    subscribeLimits: (listener) => accounts.subscribeQuota(listener),
  };
  const f = await setup({ usage: port, accounts });
  usage = createDaemonUsage(
    home,
    f.store,
    UsageSettings.parse({}),
    (error) => {
      throw error;
    },
    undefined,
    () => now,
    accounts,
  );
  const service = usage;
  cleanups.push(() => service.close());
  await service.start();
  f.store.appendEvents(
    f.thread.id,
    [
      EventPayload.parse({
        type: "agent.created",
        agent: {
          id: "root",
          threadId: f.thread.id,
          parentId: null,
          origin: "root",
          native: { provider: "codex" },
          fidelity: "full",
          model: "gpt-5.3-codex",
          cwd: home,
          status: { state: "idle" },
          background: false,
          createdAt: now,
        },
      }),
      EventPayload.parse({
        type: "usage.updated",
        agentId: "root",
        inputTokens: 1000000,
        outputTokens: 100000,
        cachedInputTokens: 200000,
        accountId: "api",
        billingMode: "api",
        counterMode: "incremental",
      }),
    ],
    now,
  );
  await service.catchUp();
  const client = await f.connect();
  await client.next();
  const device = await f.pair(["operate"]);
  const ticket = await f.ticket(device.token);
  const restricted = await f.connectTicket(device.device.id, ticket.ticket);
  await restricted.next();
  registry.ingest("api", {
    provider: "codex",
    observedAt: now + 1,
    timeZone: "UTC",
    payload: new ProviderPayload(
      JSON.stringify({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: (now + 3600000) / 1000, windowDurationMins: 300 },
        },
      }),
    ),
  });
  expect(await client.next()).toMatchObject({
    type: "usage.limits_changed",
    account: {
      id: "api",
      availability: "exhausted",
      blockedUntil: now + 3600000,
      quota: { windows: { "default:primary": { remainingPercent: 0, source: "cli" } } },
    },
  });
  restricted.send({ type: "ping" });
  expect(await restricted.next()).toMatchObject({ type: "pong" });
  const query = UsageQuery.parse({
    from: "2026-10-02",
    to: "2026-10-02",
    groupBy: ["account"],
    filters: { provider: ["codex"] },
  });
  client.send({ type: "usage.summary", requestId: "provider", query });
  const result = await client.next();
  expect(result).toMatchObject({
    type: "usage.result",
    result: {
      accounts: [{ id: "api", quota: { billingMode: "api" } }],
      rows: [
        { dimensions: { account: "api" }, totals: { estimatedUsd: 2.835, subscriptionTokens: 0 } },
      ],
      costLabel: "estimate",
      priceAsOf: "2026-10-07",
    },
  });
  client.send({
    type: "usage.series",
    requestId: "account",
    query: { ...query, bucket: "month", filters: { account: ["api"] } },
  });
  expect(await client.next()).toMatchObject({
    type: "usage.result",
    result: {
      rows: [
        { dimensions: { day: "2026-10-01", account: "api" }, totals: { inputTokens: 1000000 } },
      ],
    },
  });
});
