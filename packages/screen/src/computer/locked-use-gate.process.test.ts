import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runProtectedAttempt } from "../locked-use-attempt.ts";
import {
  connectLockedUse,
  openLockedUseConnection,
  type LockedUseConnection,
} from "../locked-use-connection.ts";
import { systemScheduler } from "../runtime.ts";
import {
  fakeLockedUseService,
  fakeLockedUseToken,
  fakeStatus,
} from "../testing/fake-locked-use-service.ts";
import type { ComputerClient } from "./client.ts";
import { lockedUseGate } from "./locked-use-gate.ts";
import { computerWorld } from "./testing/world.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Facts {
  setting: boolean;
  turn: string | undefined;
  /** Runs inside the protected interval, just before the approved step. */
  duringWork?: () => Promise<void>;
}

/**
 * The computer tools over real fake helpers whose state and act refuse as screen_locked while
 * the lock file says so, gated by a fake locked use service that unlocks it while working.
 */
async function gated(facts: Facts) {
  const dir = await mkdtemp(join(tmpdir(), "ace-gate-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, "lock");
  writeFileSync(lock, "locked");
  const service = await fakeLockedUseService(join(dir, "s.sock"));
  cleanups.push(() => service.close());
  service.onWorking = () => writeFileSync(lock, "unlocked");
  service.onRelocked = () => writeFileSync(lock, "locked");
  let connection: LockedUseConnection | undefined;
  let next = 0;
  const connect = async () =>
    (connection ??= await openLockedUseConnection(await connectLockedUse(service.path), {
      nextId: () => `r${++next}`,
      scheduler: systemScheduler,
      token: fakeLockedUseToken,
    }));
  cleanups.push(() => connection?.close());
  const protectedRuns: string[] = [];
  let running = 0;
  let client: ComputerClient | undefined;
  const gate = lockedUseGate({
    enabled: async () => facts.setting,
    status: async () => (await connect()).request({ type: "status" }),
    intervalActive: () => running > 0,
    runUnprotected: (send) => send(),
    turn: () => facts.turn,
    agentProcessIDs: async (app) => {
      const pid = await client?.helperProcessId(app);
      return pid === undefined ? [] : [pid];
    },
    runProtected: async (scope, agentProcessIDs, work, signal, optIn) => {
      protectedRuns.push(scope.turnID);
      running++;
      try {
        return await runProtectedAttempt(await connect(), {
          ...scope,
          agentProcessIDs,
          attemptID: `attempt-${protectedRuns.length}`,
          optIn,
          work: async (inner) => {
            await facts.duringWork?.();
            return work(inner);
          },
          signal,
          scheduler: systemScheduler,
        });
      } finally {
        running--;
      }
    },
  });
  const world = await computerWorld({ env: { FAKE_LOCKED: lock }, toolkit: { lockedUse: gate } });
  cleanups.push(world.close);
  client = world.client;
  return { ...world, service, protectedRuns, lock };
}

/** The same tools with no gate at all: today's behaviour. */
async function ungated(lockState: "locked" | "unlocked") {
  const dir = await mkdtemp(join(tmpdir(), "ace-gate-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, "lock");
  writeFileSync(lock, lockState);
  const world = await computerWorld({ env: { FAKE_LOCKED: lock } });
  cleanups.push(world.close);
  return world;
}

const verifiedReady = () => fakeStatus({ phase: "ready" });

it("with locked use off, a locked Mac refuses exactly as before and the service is never asked", async () => {
  const before = await (await ungated("locked")).call("screen_state", { app: "Calculator" });
  const world = await gated({ setting: false, turn: "run-7" });
  const after = await world.call("screen_state", { app: "Calculator" });
  expect(before.result.isError).toBe(true);
  expect(before.text).toContain("The Mac is locked");
  expect(after.result).toEqual(before.result);
  expect(world.service.requests).toEqual([]);
  expect(world.protectedRuns).toEqual([]);
});

it("with locked use on but the installation unverified, the refusal is unchanged", async () => {
  const before = await (
    await ungated("locked")
  ).call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "1" }],
  });
  const world = await gated({ setting: true, turn: "run-7" });
  world.service.status = fakeStatus({
    phase: "ready",
    installation: { ...verifiedReady().installation, ruleReachesMechanism: false, verified: false },
  });
  const after = await world.call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "1" }],
  });
  expect(after.result).toEqual(before.result);
  expect(world.service.requests.map((request) => request.type)).toEqual(["status"]);
  expect(world.protectedRuns).toEqual([]);
});

it("with no approved turn for the caller, the refusal is unchanged", async () => {
  const world = await gated({ setting: true, turn: undefined });
  world.service.status = verifiedReady();
  const after = await world.call("screen_state", { app: "Calculator" });
  expect(after.text).toContain("The Mac is locked");
  expect(world.protectedRuns).toEqual([]);
  expect(world.service.requests.map((request) => request.type)).not.toContain("begin");
});

it("on, verified and locked: the step runs inside a protected interval for the caller's turn", async () => {
  const world = await gated({ setting: true, turn: "run-7" });
  world.service.status = verifiedReady();
  const looked = await world.call("screen_state", { app: "Calculator" });
  expect(looked.result.isError).toBeFalsy();
  expect(looked.text).toContain("1 standard window Calculator");
  const acted = await world.call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "12*34=" }],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("1. typed 6 characters");
  expect(world.protectedRuns).toEqual(["run-7", "run-7"]);
  const begins = world.service.requests.filter((request) => request.type === "begin");
  expect(begins.map((begin) => begin.scope?.threadID)).toEqual(["thread", "thread"]);
  expect(new Set(begins.map((begin) => begin.scope?.attemptID)).size).toBe(2);
  // The app's own helper is the agent process; its input is not a takeover.
  const appHelper = world.children.at(-1)?.pid;
  expect(begins[0]?.agentProcessIDs).toEqual([appHelper]);
  expect(world.service.requests.filter((request) => request.type === "finish")).toHaveLength(2);
  expect(world.service.status).toMatchObject({ phase: "ready", session: "locked" });
});

it("on, verified and locked, a refused begin is an error the agent can read and the app is never touched", async () => {
  const world = await gated({ setting: true, turn: "run-7" });
  world.service.status = verifiedReady();
  world.service.handle("begin", (fake, request) =>
    fake.reply(request, {
      code: "manual_unlock_required",
      message: "Someone used this Mac. Unlock it by hand once before locked use resumes.",
    }),
  );
  const refused = await world.call("screen_state", { app: "Calculator" });
  expect(refused.result.isError).toBe(true);
  expect(refused.text).toContain("The person took over the Mac");
  expect((await world.ops()).filter((op) => op.startsWith("state"))).toEqual([]);
});

it("an unlocked Mac never enters the protected path, even with locked use on and verified", async () => {
  const before = await (await ungated("unlocked")).call("screen_state", { app: "Calculator" });
  const world = await gated({ setting: true, turn: "run-7" });
  writeFileSync(world.lock, "unlocked");
  world.service.status = fakeStatus({ phase: "ready", session: "unlocked" });
  const after = await world.call("screen_state", { app: "Calculator" });
  expect(after.result).toEqual(before.result);
  expect(world.protectedRuns).toEqual([]);
  expect(world.service.requests.map((request) => request.type)).toEqual(["status"]);
});

it("while an interval holds the Mac unlocked, another call is refused and never reaches the app", async () => {
  const facts: Facts = { setting: true, turn: "run-7" };
  const world = await gated(facts);
  world.service.status = verifiedReady();
  let other: Awaited<ReturnType<typeof world.call>> | undefined;
  facts.duringWork = async () => {
    // Another agent with no approved turn: the Mac now reads unlocked to it.
    facts.turn = undefined;
    other = await world.call("screen_act", {
      app: "Calculator",
      actions: [{ type: "type", text: "9" }],
    });
  };
  const looked = await world.call("screen_state", { app: "Calculator" });
  expect(looked.result.isError).toBeFalsy();
  expect(other?.result.isError).toBe(true);
  expect(other?.text).toContain("briefly unlocked for another task");
  expect((await world.ops()).filter((op) => op.startsWith("act"))).toEqual([]);
  expect(world.protectedRuns).toEqual(["run-7"]);
});

it("once the interval has ended, a Mac the person unlocked is used directly as before", async () => {
  const world = await gated({ setting: true, turn: "run-7" });
  world.service.status = verifiedReady();
  await world.call("screen_state", { app: "Calculator" });
  writeFileSync(world.lock, "unlocked");
  world.service.status = fakeStatus({ phase: "ready", session: "unlocked" });
  const acted = await world.call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "9" }],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(world.protectedRuns).toEqual(["run-7"]);
  expect(world.service.requests.filter((request) => request.type === "begin")).toHaveLength(1);
});
