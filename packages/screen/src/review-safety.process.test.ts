import { helperGate } from "./testing/gate.ts";
import { expect, it, onTestFinished } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { manager, ready, target, deferred } from "./testing/support.ts";

it("takeover discards input queued behind the same session's acknowledged gesture", async () => {
  const gate = await helperGate();
  const h = await manager({ FAKE_V2: "1", ACTION_GATE_PORT: gate.port });
  onTestFinished(async () => {
    gate.release();
    await h.close();
    await gate.close();
  });
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  const drag = h.screen.input(
    state.sessionId,
    "agent",
    { kind: "pointer.drag", x: 1, y: 2, toX: 3, toY: 4 },
    "agent",
  );
  await gate.reached;
  const queued = expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "stale" }, "agent"),
  ).rejects.toThrow("Controller changed");
  h.screen.controller(state.sessionId, "human");
  gate.release();
  await drag;
  await queued;
  expect(
    (await h.screen.uiFind(state.sessionId, { query: { name: "Name" } })).nodes[0]?.value,
  ).toBe("1");
});

for (const shutdown of ["revoke", "disable", "stop"] as const) {
  it(`${shutdown} during helper startup prevents a background app launch`, async () => {
    const preparing = deferred<void>(),
      release = deferred<string>();
    const env: NodeJS.ProcessEnv = { FAKE_V2: "1" };
    const h = await manager(env, {
      prepare: () => {
        preparing.resolve();
        return release.promise;
      },
    });
    onTestFinished(h.close);
    await h.screen.enable(true);
    await h.screen.approve(target.bundleId, true);
    const log = join(h.directory, "launches.jsonl");
    env.LAUNCH_LOG = log;
    // The fixture exposes launch effects independently of session existence.
    const launch = expect(
      h.screen.openAgentApp(
        target.bundleId,
        { threadId: "thread", agentId: "agent" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await preparing.promise;
    const stopped =
      shutdown === "revoke"
        ? h.screen.approve(target.bundleId, false)
        : shutdown === "disable"
          ? h.screen.enable(false)
          : h.screen.stopAll();
    release.resolve(process.execPath);
    await stopped;
    await launch;
    const effects = await readFile(log, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    expect(effects).toBe("");
    expect(h.screen.states()).toEqual([]);
  });
}

it("concurrent starts reserve an app before helper startup finishes", async () => {
  const entered = deferred<void>(),
    release = deferred<string>();
  const h = await manager(
    { FAKE_V2: "1" },
    {
      prepare: () => {
        entered.resolve();
        return release.promise;
      },
    },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  await h.screen.approve(target.bundleId, true);
  const first = h.screen.start(target);
  await entered.promise;
  const competing = h.screen.start(target);
  const refused = expect(competing).rejects.toMatchObject({
    code: "target_busy",
    holder: { owner: "human" },
  });
  release.resolve(process.execPath);
  await refused;
  expect((await first).lifecycle).toBe("live");
});

it("takeover cancels an action queued behind this session's native observation", async () => {
  const gate = await helperGate();
  const h = await manager({ FAKE_V2: "1", READ_GATE_PORT: gate.port });
  onTestFinished(async () => {
    gate.release();
    await h.close();
    await gate.close();
  });
  const state = await ready(h.screen);
  h.screen.controller(state.sessionId, "agent", "agent");
  const observation = expect(h.screen.uiTree(state.sessionId, {})).rejects.toThrow(
    "Controller ownership changed",
  );
  await gate.reached;
  const action = expect(
    h.screen.input(state.sessionId, "agent", { kind: "text.type", text: "stale" }, "agent"),
  ).rejects.toThrow("Controller changed");
  h.screen.controller(state.sessionId, "human");
  gate.release();
  await observation;
  await action;
  expect(
    (await h.screen.uiFind(state.sessionId, { query: { name: "Changes" } })).nodes[0]?.value,
  ).toBe("0");
});
