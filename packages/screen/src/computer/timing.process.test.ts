import { afterEach, expect, it } from "vitest";
import type { ComputerRequestTiming } from "./client.ts";
import { computerWorld } from "./testing/world.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it("diagnostics separate cold helper startup from the next request's queue wait", async () => {
  let now = 0;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: starting, resolve: started } = Promise.withResolvers<void>();
  const timings: ComputerRequestTiming[] = [];
  const world = await computerWorld({
    client: {
      helper: async () => {
        started();
        await gate;
        now = 40;
        return "fixture";
      },
      timing: { now: () => now, report: (timing) => timings.push(timing) },
    },
  });
  cleanups.push(world.close);
  const first = world.client.request("state", { app: "com.apple.calculator" });
  // The test owns the clock: the second request queues at 10, once the first is starting the
  // helper, however many awaits the client takes before resolving the helper's command.
  await starting;
  now = 10;
  const second = world.client.request("state", { app: "com.apple.calculator" });
  release();
  await Promise.all([first, second]);
  expect(timings).toMatchObject([
    {
      op: "state",
      app: "com.apple.calculator",
      outcome: "ok",
      queueMs: 0,
      startupMs: 40,
      totalMs: 40,
    },
    {
      op: "state",
      app: "com.apple.calculator",
      outcome: "ok",
      queueMs: 30,
      startupMs: 0,
      totalMs: 30,
    },
  ]);
});

it("a failing diagnostic consumer cannot fail an action or strand its next request", async () => {
  const world = await computerWorld({
    client: {
      timing: {
        report: () => {
          throw new Error("diagnostic sink unavailable");
        },
      },
    },
  });
  cleanups.push(world.close);
  const first = world.client.request("act", {
    app: "com.apple.calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  const second = world.client.request("state", { app: "com.apple.calculator" });
  await expect(first).resolves.toMatchObject({ done: ["did key"] });
  await expect(second).resolves.toMatchObject({ app: { bundleId: "com.apple.calculator" } });
});
