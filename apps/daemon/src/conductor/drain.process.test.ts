import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ConductorStore } from "@ace/conductor";
import { ConductorRuntime } from "../conductor-runtime.ts";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";

afterEach(closeDeckFixtures);

test("queued runs beyond eight draining actors all execute when host tasks release", async () => {
  const h = await deckFixture();
  const storage = new ConductorStore(join(h.home, "queue.sqlite"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const launched = new Set<string>();
  let sequence = 0;
  const env = {
    now: h.clock.now,
    id: () => `queue-${++sequence}`,
    agentId: () => h.spec.rootAgentId,
  };
  const runtime = new ConductorRuntime(storage, h.daemon.store, env, {
    autostart: false,
    execute: async (effect, state) => {
      if (effect.type === "launch" && state) {
        launched.add(state.id);
        if (launched.size === 8) entered.resolve();
        await release.promise;
      }
      return [];
    },
  });
  try {
    for (let index = 0; index < 12; index++)
      storage.create(`queued-${index}`, h.spec, env, [
        {
          id: "local.codex",
          provider: "codex",
          capacity: 4,
          externalActive: 0,
          quota: 100,
          resetAt: null,
        },
      ]);
    runtime.start();
    await entered.promise;
    // Admission while every cached actor is awaiting I/O persists rather than refusing.
    storage.create("queued-extra", h.spec, env, [
      {
        id: "local.codex",
        provider: "codex",
        capacity: 4,
        externalActive: 0,
        quota: 100,
        resetAt: null,
      },
    ]);
    runtime.retry("queued-extra");
    release.resolve();
    await runtime.flush();
    expect(launched.size).toBe(13);
  } finally {
    release.resolve();
    await runtime.close();
  }
});

test("an intent arriving between drain completion and task release wakes without a timer", async () => {
  const h = await deckFixture();
  const storage = new ConductorStore(join(h.home, "wake.sqlite"));
  let stopped = false;
  let sequence = 0;
  const runtime = new ConductorRuntime(
    storage,
    h.daemon.store,
    {
      now: h.clock.now,
      id: () => `wake-${++sequence}`,
      agentId: () => h.spec.rootAgentId,
    },
    {
      autostart: false,
      execute: async (effect) => {
        if (effect.type === "launch") {
          // Cross the resolved drain's continuation before its finally releases the run.
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => runtime.fact("wake", "cancel", { type: "cancel" })),
            ),
          );
        }
        if (effect.type === "control" && effect.action === "cancel") {
          stopped = true;
          return [
            {
              type: "status",
              laneId: effect.lane.id,
              generation: effect.lane.generation,
              status: "done",
              at: h.clock.now(),
            },
          ];
        }
        return [];
      },
    },
  );
  try {
    storage.create(
      "wake",
      h.spec,
      { now: h.clock.now, id: () => `wake-${++sequence}`, agentId: () => h.spec.rootAgentId },
      [
        {
          id: "local.codex",
          provider: "codex",
          capacity: 4,
          externalActive: 0,
          quota: 100,
          resetAt: null,
        },
      ],
    );
    runtime.start();
    await runtime.flush();
    expect(stopped).toBe(true);
    expect(runtime.get("wake")?.phase).toBe("cancelled");
  } finally {
    await runtime.close();
  }
});
