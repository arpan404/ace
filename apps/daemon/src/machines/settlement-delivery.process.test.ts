import { expect, test } from "vitest";
import { POLL_MS, done, machine, parent, working } from "./children-test-support.ts";
import { RECHECK_POLLS } from "./child-recheck.ts";
import { MachineFailure } from "./transport.ts";

const failure = {
  code: "usage_limited",
  message: "Account Primary is out of usage until reset.",
  accountId: "account-a",
  accountLabel: "Primary",
  resetsAt: 5000,
} as const;

test("a slow machine never delays a result already received from another machine", async () => {
  const h = machine();
  h.report(h.add("slow", "a-studio"), working);
  h.report(h.add("fast", "z-laptop"), done("Ready immediately"));
  const held = h.holdNextStatus();
  const poll = h.children.poll();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.delivered.join("\n")).toContain("Ready immediately");
  } finally {
    held.release();
    await poll;
  }
});

test("an offline child's failure is delivered after reconnect and source restart, with its reason intact", async () => {
  const h = machine();
  const child = h.add("limited");
  h.reads.error = new MachineFailure("offline");
  await h.children.poll();
  expect(h.delivered).toEqual([]);
  h.children.close();
  const restored = machine(h.home);
  restored.report(child, {
    state: "failed",
    status: { state: "failed" },
    failure,
    result: failure.message,
  });
  await restored.children.poll();
  expect(restored.children.watched(child)?.view).toMatchObject({
    state: "failed",
    failure,
    result: failure.message,
  });
  expect(restored.delivered).toHaveLength(1);
  expect(restored.delivered[0]).toContain("usage_limited");
  await restored.children.poll();
  expect(restored.delivered).toHaveLength(1);
});

const logged = (h: ReturnType<typeof machine>, message: string) =>
  h.logs.filter((line) => line.message === message);

test("a stopped parent's result waits untried and quiet, and reaches it at once when it is resumed", async () => {
  const h = machine();
  h.stopped.add(parent);
  h.report(h.add("child"), done("Finished while the parent was stopped"));
  await h.fire();
  for (let poll = 0; poll < 4; poll++) {
    h.clock.now += 60_000;
    await h.fire();
  }
  expect(h.attempts).toEqual([]);
  expect(logged(h, "Machine result waits for its stopped parent")).toHaveLength(1);
  // Nothing to try until the parent is resumed: only the slow re-check pace is left, and the
  // waiting result is asked about once a minute, never every poll.
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);

  h.stopped.delete(parent);
  h.children.threadChanged(parent);
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS]);
  await h.fire();
  expect(h.delivered).toEqual([expect.stringContaining("Finished while the parent was stopped")]);
  await h.fire();
  expect(h.delivered).toHaveLength(1);
});

test("a delivery that keeps failing backs off, is logged once, and is delivered when the parent takes it", async () => {
  const h = machine();
  h.answers.deliver = () => {
    throw new Error("Agent control is not ready");
  };
  h.report(h.add("child"), done("Ready"));
  await h.fire();
  expect(h.attempts).toHaveLength(1);
  // Polls before the wait is over don't try again; each failure doubles the wait.
  await h.fire();
  expect(h.attempts).toHaveLength(1);
  for (const wait of [1_000, 2_000, 4_000]) {
    h.clock.now += wait;
    await h.fire();
  }
  expect(h.attempts).toHaveLength(4);
  // Only the slow re-check pace polls now, never the one-second retry of every poll.
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);
  h.clock.now += 4_000;
  await h.fire();
  expect(h.attempts).toHaveLength(4);
  expect(logged(h, "Machine result not delivered yet")).toHaveLength(1);

  h.answers.deliver = () => {};
  h.clock.now += 4_000;
  await h.fire();
  expect(h.delivered).toEqual([expect.stringContaining("Ready")]);
  expect(logged(h, "Machine result delivered after failing")).toEqual([
    expect.objectContaining({ fields: expect.objectContaining({ attempts: 5 }) }),
  ]);
  h.clock.now += 60_000;
  await h.fire();
  expect(h.attempts).toHaveLength(5);
});

test("a result whose parent was deleted ends once, recorded once, and is never tried again", async () => {
  const h = machine();
  h.answers.deliver = () => "gone";
  const child = h.add("child");
  h.report(child, done("Nobody to tell"));
  for (let poll = 0; poll < 4; poll++) {
    await h.fire();
    h.clock.now += 60_000;
  }
  expect(h.attempts).toHaveLength(1);
  expect(logged(h, "Machine result dropped: its parent thread is gone")).toHaveLength(1);
  expect(h.state(child)).toBe("done");
});

test("re-checks of a machine that can't be reached back off, log once, and resume when it answers", async () => {
  const h = machine();
  const child = h.add("child");
  h.report(child, done("First pass done."));
  await h.fire();
  h.asked.length = 0;

  h.reads.error = new MachineFailure("offline");
  await h.fire();
  await h.fire();
  await h.fire();
  // Asked once: polls before its wait is over leave the machine alone.
  expect(h.asked).toHaveLength(1);
  h.clock.now += POLL_MS;
  await h.fire();
  expect(h.asked).toHaveLength(2);
  expect(logged(h, "Machine children unreachable")).toHaveLength(1);
  expect(h.state(child)).toBe("done");

  h.reads.error = undefined;
  h.clock.now += 60_000;
  await h.fire();
  expect(h.asked).toHaveLength(3);
  await h.fire();
  expect(h.asked).toHaveLength(4);
  expect(logged(h, "Machine children reachable again")).toEqual([
    expect.objectContaining({ fields: expect.objectContaining({ attempts: 3 }) }),
  ]);
});

test("a machine answering another call again is asked about its children on the next poll", async () => {
  const h = machine();
  const child = h.add("child");
  h.reads.error = new MachineFailure("offline");
  await h.fire();
  await h.fire();
  expect(h.asked).toHaveLength(1);
  h.reads.error = undefined;
  h.report(child, done("Back online"));
  h.children.machineReachable("studio");
  await h.fire();
  expect(h.asked).toHaveLength(2);
  expect(h.delivered).toEqual([expect.stringContaining("Back online")]);
});
