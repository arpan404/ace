import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConductorDriver, ConductorStore, executor, fakePorts, progress } from "./index.ts";
import { accounts, completion, environment, plan, review, spec } from "./test-support.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ace-conductor-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "run.sqlite");
  const env = environment();
  const fake = fakePorts(env.now);
  const store = new ConductorStore(path);
  cleanups.push(() => store.close());
  const driver = new ConductorDriver(store, executor(fake.ports), env);
  driver.command("start", { type: "conductor.start", runId: "run", spec: spec() });
  driver.fact("run", "accounts", { type: "accounts", accounts });
  return { path, env, fake, store, driver };
}

it("restart replays a pending launch with the same identity and preserves the agent tree", async () => {
  const { path, env, fake, store } = setup();
  const pending = store.pending("run");
  const launch = pending.find((e) => e.type === "launch");
  if (!launch || launch.type !== "launch") throw new Error("Missing launch");
  // External success followed by a crash before the SQLite acknowledgement.
  await executor(fake.ports)(launch);
  const reopened = new ConductorStore(path);
  cleanups.push(() => reopened.close());
  const driver = new ConductorDriver(reopened, executor(fake.ports), env);
  await driver.drain("run");
  expect(fake.sessions.size).toBe(1);
  expect(fake.tree.get(launch.lane.id)?.parentId).toBe(launch.rootAgentId);
  expect(progress(reopened.load("run") ?? launchState()).lanes[0]?.id).toBe(launch.lane.id);
  expect(reopened.pending("run")).toEqual([]);
});
function launchState(): never {
  throw new Error("Missing persisted run");
}

it("duplicate input receipts cannot create extra sessions or substitute another fact", async () => {
  const { store, driver, fake, env } = setup();
  await driver.drain("run");
  const planner = progress(store.load("run") ?? launchState()).lanes[0];
  if (!planner) throw new Error("Missing planner");
  const artifact = {
    type: "artifact",
    laneId: planner.id,
    generation: 0,
    artifact: { kind: "plan", plan: plan() },
  };
  driver.fact("run", "plan", artifact);
  driver.fact("run", "plan", artifact);
  driver.fact("run", "done", {
    type: "status",
    laneId: planner.id,
    generation: 0,
    status: "done",
    at: env.now(),
  });
  driver.fact("run", "done", { type: "cancel" });
  await driver.drain("run");
  expect(fake.sessions.size).toBe(2);
  expect(progress(store.load("run") ?? launchState()).dag[0]?.state).toBe("working");
});

it("failed effect execution keeps its intent and retries without invisible sessions", async () => {
  const { env, fake, store } = setup();
  const original = fake.ports.orchestrator.attach;
  fake.ports.orchestrator.attach = async () => {
    throw new Error("Attachment unavailable");
  };
  const driver = new ConductorDriver(store, executor(fake.ports), env);
  await expect(driver.drain("run")).rejects.toThrow("Attachment unavailable");
  expect(fake.sessions.size).toBe(0);
  expect(store.pending("run")).toHaveLength(1);
  fake.ports.orchestrator.attach = original;
  await driver.drain("run");
  expect(fake.sessions.size).toBe(1);
});

it("invalid effect results roll back the snapshot and keep the completed external intent pending", () => {
  const { env, store } = setup();
  const effect = store.pending("run")[0];
  if (!effect) throw new Error("Missing effect");
  expect(() =>
    store.complete("run", effect.id, [{ type: "cancel" }, { type: "unknown" }], env),
  ).toThrow();
  expect(progress(store.load("run") ?? launchState()).phase).toBe("planning");
  expect(store.pending("run")[0]?.id).toBe(effect.id);
});

it("pause prevents pending launches and cancel closes even a lane that never started", async () => {
  const { driver, fake, store } = setup();
  driver.command("pause", { type: "conductor.pause", runId: "run" });
  await driver.drain("run");
  expect(fake.sessions.size).toBe(0);
  driver.command("cancel", { type: "conductor.cancel", runId: "run" });
  await driver.drain("run");
  expect(progress(store.load("run") ?? launchState()).phase).toBe("cancelled");
  expect(fake.sessions.size).toBe(0);
  store.delete("run");
  expect(store.load("run")).toBeNull();
  expect(store.pending("run")).toEqual([]);
});

it("invalid facts roll back and their receipt can be reused for a corrected fact", () => {
  const { driver, store } = setup();
  expect(() =>
    driver.fact("run", "bad", { type: "accounts", accounts: [accounts[0], accounts[0]] }),
  ).toThrow("duplicate_account");
  driver.fact("run", "bad", { type: "pause" });
  expect(progress(store.load("run") ?? launchState()).phase).toBe("paused");
  expect(() => store.delete("run")).toThrow("run_still_live");
});

it("a merge and its post-merge verification resume separately after reopening SQLite", async () => {
  const { env, driver, fake, store, path } = setup();
  await driver.drain("run");
  const emit = (receipt: string, fact: unknown) => driver.fact("run", receipt, fact);
  const planner = progress(store.load("run") ?? launchState()).lanes[0];
  if (!planner) throw new Error("Missing planner");
  emit("plan", {
    type: "artifact",
    laneId: planner.id,
    generation: 0,
    artifact: { kind: "plan", plan: plan() },
  });
  emit("plan.done", {
    type: "status",
    laneId: planner.id,
    generation: 0,
    status: "done",
    at: env.now(),
  });
  await driver.drain("run");
  const worker = progress(store.load("run") ?? launchState()).lanes[0];
  if (!worker) throw new Error("Missing worker");
  emit("work", {
    type: "artifact",
    laneId: worker.id,
    generation: 0,
    artifact: { kind: "completion", completion: completion() },
  });
  emit("work.done", {
    type: "status",
    laneId: worker.id,
    generation: 0,
    status: "done",
    at: env.now(),
  });
  await driver.drain("run");
  const reviewer = progress(store.load("run") ?? launchState()).lanes[0];
  if (!reviewer) throw new Error("Missing reviewer");
  emit("review", {
    type: "artifact",
    laneId: reviewer.id,
    generation: 0,
    artifact: { kind: "review", revision: "a".repeat(40), review: review("a") },
  });
  emit("review.done", {
    type: "status",
    laneId: reviewer.id,
    generation: 0,
    status: "done",
    at: env.now(),
  });
  await driver.drain("run", 1);
  expect(fake.merged.map((m) => m.branch)).toEqual(["work/a"]);
  expect(progress(store.load("run") ?? launchState()).dag[0]?.state).toBe("verifying");
  const reopened = new ConductorStore(path);
  cleanups.push(() => reopened.close());
  await new ConductorDriver(reopened, executor(fake.ports), env).drain("run");
  expect(progress(reopened.load("run") ?? launchState()).phase).toBe("done");
  expect(fake.merged).toHaveLength(1);
});

it("effects that return malformed external data fail validation before acknowledgement", async () => {
  const { env, fake } = setup();
  fake.ports.git.merge = async () => ({
    revision: "not-a-revision",
    conflict: null,
    trivial: false,
  });
  await expect(
    executor(fake.ports)({
      type: "merge",
      id: "merge",
      workstream: "a",
      completion: completion(),
      mode: "local",
    }),
  ).rejects.toThrow();
  // Data from the injected clock stays at the boundary, with no wall-clock sleeps.
  expect(env.now()).toBe(100);
});

async function prepareMerge(context: ReturnType<typeof setup>) {
  const { driver, store, env } = context;
  let input = 0;
  const send = (fact: unknown) => driver.fact("run", `prepare-${++input}`, fact);
  const lane = () => {
    const l = progress(store.load("run") ?? launchState()).lanes[0];
    if (!l) throw new Error("No active lane");
    return l;
  };
  const finish = (artifact: unknown) => {
    const l = lane();
    send({ type: "artifact", laneId: l.id, generation: l.generation, artifact });
    send({ type: "status", laneId: l.id, generation: l.generation, status: "done", at: env.now() });
  };
  await driver.drain("run");
  finish({ kind: "plan", plan: plan() });
  await driver.drain("run");
  finish({ kind: "completion", completion: completion() });
  await driver.drain("run");
  finish({ kind: "review", revision: "a".repeat(40), review: review("a") });
}

it("cancelling an in-flight merge still verifies the resulting revision before reporting cancelled", async () => {
  const context = setup();
  await prepareMerge(context);
  const { driver, store, fake } = context;
  const original = fake.ports.git.merge;
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  fake.ports.git.merge = async (key, branch) => {
    started.resolve();
    await released.promise;
    return original(key, branch);
  };
  const running = driver.drain("run");
  await started.promise;
  await expect(driver.drain("run")).rejects.toThrow("driver_busy");
  driver.command("cancel", { type: "conductor.cancel", runId: "run" });
  expect(progress(store.load("run") ?? launchState()).phase).toBe("cancelling");
  released.resolve();
  await running;
  expect(progress(store.load("run") ?? launchState())).toMatchObject({
    phase: "cancelled",
    dag: [{ state: "integrated" }],
  });
  expect(fake.merged.map((c) => c.revision)).toEqual(["a".repeat(40)]);
});

it("cancel before a queued merge starts leaves the repository untouched", async () => {
  const context = setup();
  await prepareMerge(context);
  context.driver.command("cancel", { type: "conductor.cancel", runId: "run" });
  await context.driver.drain("run");
  expect(context.fake.merged).toEqual([]);
  expect(progress(context.store.load("run") ?? launchState()).phase).toBe("cancelled");
});

it("a stalled pending launch cannot execute behind an escalation gate", async () => {
  const { driver, store, fake, env } = setup();
  env.advance(1001);
  driver.fact("run", "tick", { type: "tick" });
  await driver.drain("run");
  expect(fake.sessions.size).toBe(0);
  expect(fake.interactions.size).toBe(1);
  const gate = progress(store.load("run") ?? launchState()).needsUser[0];
  if (!gate) throw new Error("No gate");
  driver.command("retry", {
    type: "conductor.approve",
    runId: "run",
    approval: { gateId: gate.id, decision: "approve" },
  });
  await driver.drain("run");
  expect(fake.sessions.size).toBe(1);
  expect(fake.interactions.size).toBe(0);
  expect(progress(store.load("run") ?? launchState()).lanes[0]?.role).toBe("planner");
});
