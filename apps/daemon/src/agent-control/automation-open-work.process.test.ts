import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { end } from "../engine/test-support.ts";
import { automationFixture } from "./automation-test-support.ts";

type Fixture = Awaited<ReturnType<typeof automationFixture>>;

/** Automations an agent made from its one Claude thread, with the global switch on. */
async function setUp() {
  const f = await automationFixture("claude");
  await f.save("alpha", "Run alpha");
  await f.save("beta", "Run beta");
  await f.settings.set("automations.enabled", true, { kind: "global" });
  await f.settings.settled({ kind: "global" });
  return f;
}

const shell = (stoppable: boolean): Fact => ({
  type: "background.started",
  agent: "root",
  task: "shell",
  kind: "shell",
  title: "Background build",
  stoppable,
});

/** A delegation that prepares a worktree first, asked for under `requestId`. */
const request = (requestId: string) => ({
  requestId,
  task: "Work in a worktree",
  role: `prepared-${requestId}`,
  provider: "claude" as const,
  model: "chosen-model",
  wait: false,
  estimatedLoad: 0,
});

/** Run alpha and wait until its message is the turn the thread is on. */
async function alphaTurn(f: Fixture) {
  await f.run("alpha", "alpha-1");
  await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
  await f.h.engine.flush();
}

/** Let the daemon act on what just happened. */
async function settle(f: Fixture) {
  for (let i = 0; i < 3; i++) {
    await f.h.engine.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("a run whose turn ended with its background task still going stays running until the task ends", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, shell(true), end);
    await settle(f);
    expect((await f.latest("alpha"))?.status).toBe("running");
    await f.h.emit(f.caller.threadId, {
      type: "background.ended",
      task: "shell",
      status: "completed",
    });
    await expect.poll(async () => (await f.latest("alpha"))?.status).toBe("succeeded");
  } finally {
    await f.close();
  }
});

test("pausing a run whose turn left a background task going stops that task, then the run", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, shell(true), end);
    await settle(f);
    await f.setEnabled("alpha", false);
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    expect(f.h.stoppedTasks).toEqual(["shell"]);
    // Resumed, its next run goes in rather than waiting behind leftover work.
    await f.setEnabled("alpha", true);
    await f.run("alpha", "alpha-2");
    await expect
      .poll(() => f.h.inputs.get(f.caller.threadId))
      .toEqual(["plan", "Run alpha", "Run alpha"]);
  } finally {
    await f.close();
  }
});

test("a paused run stays running while a background task it can't stop still works", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, shell(false));
    await f.setEnabled("alpha", false);
    await settle(f);
    // The pause stopped the turn; the shell it started keeps going, so the run isn't over.
    expect(f.h.store.getThread(f.caller.threadId)?.queue?.reason).toBe("stopped");
    expect((await f.latest("alpha"))?.status).toBe("running");
    await f.h.emit(f.caller.threadId, {
      type: "background.ended",
      task: "shell",
      status: "completed",
    });
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
  } finally {
    await f.close();
  }
});

test("a delegation the run's turn is still preparing keeps the run open, and pausing cancels only it", async () => {
  const f = await setUp();
  try {
    // Another turn's preparation, made before the run: not the run's to cancel.
    const others = f.h.service.reserve(f.caller, request("before"));
    await alphaTurn(f);
    const reservation = f.h.service.reserve(f.caller, request("during"));
    const preparing = f.h.service.watchReservation(reservation);
    await f.answer(2, "alpha-answer", "Alpha asked for a worktree.");
    await settle(f);
    expect((await f.latest("alpha"))?.status).toBe("running");
    await f.setEnabled("alpha", false);
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    // Its preparation is aborted and gone for good, so it can never launch a child.
    expect(preparing.signal.aborted).toBe(true);
    expect(f.h.service.journal.reservationOf(reservation.record.childId)).toBeUndefined();
    expect(f.h.service.journal.reservationOf(others.record.childId)).toBeDefined();
  } finally {
    await f.close();
  }
});

test("a delegated thread another run reopens belongs to that run, not the run that started it", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    const child = ThreadId.parse(f.h.delegate(f.caller, "helper").childId);
    await settle(f);
    await f.h.complete(child, "Helped alpha.");
    await f.answer(2, "alpha-answer", "Alpha done.");
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "succeeded", result: "Alpha done." });
    // Beta's turn sends the same child more work: a new generation, beta's own.
    await f.run("beta", "beta-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run beta");
    expect(
      f.h.service.message(f.caller, "beta-follow-up", child, "One more thing", "queue").ok,
    ).toBe(true);
    await settle(f);
    await f.answer(3, "beta-answer", "Beta waits on the helper.");
    await settle(f);
    expect(f.h.store.getThread(child)?.status.state).toBe("working");
    expect((await f.latest("beta"))?.status).toBe("running");
    await f.setEnabled("beta", false);
    await expect
      .poll(() => f.latest("beta"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    expect(f.h.store.getThread(child)?.status.state).not.toBe("working");
    expect((await f.latest("alpha"))?.result).toBe("Alpha done.");
  } finally {
    await f.close();
  }
});
