import { afterEach, expect, test } from "vitest";
import { ConductorSpec } from "@ace/protocol";
import { ConductorClient } from "./index.ts";
import { setup, ready, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// Not executed (tests run at merge). An unavailable allowlisted account keeps this run idle.
test("Deck watches reacquire a snapshot on reconnect and stop receiving after close", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults, scheduler } = f.make();
  const control = f.make().client;
  await ready(client);
  await ready(control);
  const model = { provider: "claude", model: "scripted", tier: "normal", cost: 0, quota: 1 };
  const spec = ConductorSpec.parse({
    rootAgentId: "deck-root",
    workspaceId: f.workspaceId,
    goal: "Watch the idle Deck",
    repositoryRules: "",
    constraints: {
      providers: ["claude"],
      models: ["scripted"],
      accounts: ["not-installed"],
      budget: 10,
      maxParallel: 1,
      deadline: null,
      stallAfterMs: 1000,
    },
    policies: {
      planApproval: "auto",
      merge: "ask",
      maxFixRounds: 1,
      roles: { planner: [model], worker: [model], reviewer: [model], integrator: [model] },
    },
  });
  expect(await control.command({ type: "conductor.start", runId: "watched", spec })).toMatchObject({
    ok: true,
  });
  const decks = new ConductorClient(client, () => "deck-watch");
  const watch = decks.watch("watched");
  try {
    await when(watch.run, Boolean);
    const startedAt = watch.run.getSnapshot()?.startedAt;
    faults.disconnect();
    await when(client.connectionState(), (state) => state === "reconnecting");
    expect(await control.command({ type: "conductor.pause", runId: "watched" })).toMatchObject({
      ok: true,
    });
    scheduler.advance(1000);
    await when(watch.run, (run) => run?.phase === "paused");
    expect(watch.run.getSnapshot()?.startedAt).toBe(startedAt);
    expect(watch.error.getSnapshot()).toBeUndefined();
    expect((await decks.list()).runs.some((run) => run.id === "watched")).toBe(true);
    watch.close();
    expect(await control.command({ type: "conductor.cancel", runId: "watched" })).toMatchObject({
      ok: true,
    });
    expect((await decks.get("watched")).phase).toBe("cancelled");
    expect(watch.run.getSnapshot()?.phase).toBe("paused");
  } finally {
    watch.close();
  }
});
