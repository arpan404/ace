import { expect, it } from "vitest";
import { RECHECK_PER_MACHINE, RECHECK_POLLS } from "./child-recheck.ts";
import { HOUR, POLL_MS, done, machine, message, working } from "./children-test-support.ts";

it("a message its machine has not answered for keeps the child open, even across a restart, until it is answered", async () => {
  const first = machine();
  const id = first.add("child");
  first.report(id, done("First pass done."));
  await first.fire();
  expect(first.state(id)).toBe("done");

  // The message leaves, and the reply never comes back (a timeout, or the caller stops).
  first.children.send(id, message("second-pass"));
  first.children.close();
  const restarted = machine(first.home);
  restarted.report(id, done("First pass done."));
  restarted.answers.resend = async () => {
    throw new Error("Studio is unreachable");
  };
  // Its machine still reports the earlier result: that can't settle it while the message is open.
  // Each failed retry waits longer before the next (one second, then two).
  await restarted.fire();
  restarted.clock.now += 1_000;
  await restarted.fire();
  expect(restarted.state(id)).toBe("working");
  expect(restarted.resent).toEqual(["second-pass", "second-pass"]);
  expect(restarted.delivered).toEqual([]);

  // Sent again under the same id, the machine answers for it: the work runs and settles.
  restarted.answers.resend = async () => "taken";
  restarted.report(id, working);
  restarted.clock.now += 2_000;
  await restarted.fire();
  expect(restarted.state(id)).toBe("working");
  restarted.report(id, done("Second pass done.", 9));
  await restarted.fire();
  expect(restarted.state(id)).toBe("done");
  expect(restarted.delivered).toEqual([expect.stringContaining("Second pass done.")]);
});

it("an answer the store could not save is not lost: the message is sent again and the child settles", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, working);
  await h.fire();
  const release = h.children.send(id, message("follow-up"));
  h.faults.failNextWrite = true;
  release("taken");

  // The answer did not stick: the child stays open, and the next poll asks again.
  h.report(id, done("Follow-up done."));
  await h.fire();
  expect(h.resent).toEqual(["follow-up"]);
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toEqual([expect.stringContaining("Follow-up done.")]);
});

it("an unchanged result after a follow-up that never ran is not repeated, and polling goes quiet", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  expect(h.delivered).toHaveLength(1);
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);

  // A follow-up its machine refused: the child reopens, then reads the same result again.
  h.children.send(id, message("refused"))("refused");
  await h.fire();
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toHaveLength(1);
  // Back at the slow re-check pace, and after the re-check window, no polling at all.
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);
  h.clock.now += 25 * HOUR;
  await h.fire();
  expect(h.timers).toEqual([]);
});

it("with more settled children than one re-check asks about, every one is checked in turn", async () => {
  const h = machine();
  const ids = Array.from({ length: RECHECK_PER_MACHINE + 1 }, (_, index) =>
    h.add(`child-${index}`),
  );
  for (const id of ids) h.report(id, done(`Result ${id}`));
  await h.fire();
  for (const id of ids) expect(h.state(id), id).toBe("done");
  h.asked.length = 0;

  // The first turn asks about at most a batch; the child it left out goes next, and work the
  // person there gave it is noticed then.
  await h.fire();
  const first = new Set(h.asked.flat());
  expect(first.size).toBe(RECHECK_PER_MACHINE);
  const left = ids.find((id) => !first.has(id));
  if (!left) throw new Error("Every child was asked about at once");
  h.report(left, working);
  await h.fire();
  expect(h.asked.at(-1)).toContain(left);
  expect(h.state(left)).toBe("working");
  expect(h.asked.every((batch) => batch.length <= RECHECK_PER_MACHINE)).toBe(true);
});

it("a status reply read before a retried message was taken can't settle the child when saving the take fails", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  expect(h.delivered).toHaveLength(1);
  // A follow-up whose reply was lost: it is sent again on the next poll.
  h.children.send(id, message("second"))(undefined);

  // That poll's status reply reads the old result and is held back; meanwhile the machine takes
  // the message again, but the write that would fence that old reply fails.
  const held = h.holdNextStatus();
  h.faults.failSql = "generation=generation+1";
  await h.fire();
  expect(h.resent).toEqual(["second"]);
  await held.release();
  expect(h.state(id)).toBe("working");
  expect(h.delivered).toHaveLength(1);

  // Taken again with the store healthy once its retry is due, the work runs and its own result
  // reaches the parent.
  h.report(id, working);
  h.clock.now += 1_000;
  await h.fire();
  await h.fire();
  h.report(id, done("Second pass done.", 9));
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toEqual([
    expect.stringContaining("First pass done."),
    expect.stringContaining("Second pass done."),
  ]);
});

it("messages to an unreachable machine never hold back a message to a healthy one", async () => {
  const h = machine();
  // Sixteen children on a machine that can't be reached, sent messages first, then one on a
  // healthy machine.
  const stuck = Array.from({ length: 16 }, (_, index) => h.add(`stuck-${index}`, "down"));
  const healthy = h.add("healthy", "studio");
  for (const id of [...stuck, healthy]) h.report(id, working);
  await h.fire();
  for (const id of [...stuck, healthy]) h.children.send(id, message(`follow-up-${id}`))(undefined);
  h.answers.resend = async (host) => {
    if (host === "down") throw new Error("down is unreachable");
    return "taken";
  };

  // The healthy machine's message goes, though older ones wait ahead of it.
  await h.fire();
  expect(h.resent).toContain(`follow-up-${healthy}`);
  h.report(healthy, done("Healthy work done."));
  await h.fire();
  expect(h.state(healthy)).toBe("done");
  expect(h.delivered).toEqual([expect.stringContaining("Healthy work done.")]);
  // The unreachable ones stay open, and are tried again in turn as their waits run out.
  for (const id of stuck) expect(h.state(id), id).toBe("working");
  const tried = new Set(h.resent.filter((sent) => sent.includes("stuck")));
  h.clock.now += 60_000;
  for (let poll = 0; poll < 4; poll++) await h.fire();
  for (const sent of h.resent) tried.add(sent);
  for (const id of stuck) expect(tried, id).toContain(`follow-up-${id}`);
});

/**
 * The machine's answers to messages sent again, held open until the test releases them, so a
 * test can count what is in flight at each moment, per machine.
 */
function gatedResends(h: ReturnType<typeof machine>) {
  const open: { host: string; answer: (value: "taken") => void }[] = [];
  h.answers.resend = (host) =>
    new Promise((resolve) => {
      open.push({ host, answer: resolve });
    });
  return {
    inFlight: (host?: string) =>
      open.filter((entry) => host === undefined || entry.host === host).length,
    async releaseAll() {
      for (const entry of open.splice(0)) entry.answer("taken");
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

it("an unanswered message waits out its saved retry wait, even across a restart, then is sent exactly once", async () => {
  const first = machine();
  const id = first.add("child");
  first.report(id, working);
  await first.fire();
  first.children.send(id, message("follow-up"))(undefined);
  first.answers.resend = async () => {
    throw new Error("Studio is unreachable");
  };
  // The first retry goes at once; the next waits one second, the one after that two.
  await first.fire();
  expect(first.resent).toEqual(["follow-up"]);
  first.clock.now += 999;
  await first.fire();
  expect(first.resent).toEqual(["follow-up"]);
  first.clock.now += 1;
  await first.fire();
  expect(first.resent).toEqual(["follow-up", "follow-up"]);

  // The caller restarts mid-wait: the saved wait still holds.
  first.children.close();
  const restarted = machine(first.home);
  restarted.clock.now = first.clock.now;
  restarted.report(id, working);
  restarted.answers.resend = async () => {
    throw new Error("Studio is unreachable");
  };
  restarted.clock.now += 1_999;
  await restarted.fire();
  expect(restarted.resent).toEqual([]);
  restarted.clock.now += 1;
  await restarted.fire();
  expect(restarted.resent).toEqual(["follow-up"]);
});

it("at most four messages go to one machine at once, and a message to another machine still goes meanwhile", async () => {
  const h = machine();
  const busy = Array.from({ length: 6 }, (_, index) => h.add(`busy-${index}`, "busy"));
  const other = h.add("other", "other");
  for (const id of [...busy, other]) h.report(id, working);
  await h.fire();
  const gates = gatedResends(h);
  for (const id of busy) h.children.send(id, message(`to-${id}`))(undefined);
  await h.fire();
  expect(gates.inFlight("busy")).toBe(4);

  // While that machine is full its other messages wait, and another machine's goes out.
  h.children.send(other, message(`to-${other}`))(undefined);
  h.clock.now += 60_000;
  await h.fire();
  expect(gates.inFlight("busy")).toBe(4);
  expect(gates.inFlight("other")).toBe(1);

  // As answers come, the waiting ones go, and every message is answered.
  for (let round = 0; round < 3; round++) {
    await gates.releaseAll();
    h.clock.now += 60_000;
    await h.fire();
  }
  expect(new Set(h.resent)).toEqual(new Set([...busy, other].map((id) => `to-${id}`)));
  expect(gates.inFlight()).toBe(0);
  const sent = h.resent.length;
  h.clock.now += 60_000;
  await h.fire();
  expect(h.resent).toHaveLength(sent);
});

it("at most sixteen messages are sent again at once across all machines, and all are answered", async () => {
  const h = machine();
  const ids = Array.from({ length: 24 }, (_, index) =>
    h.add(`child-${index}`, `host-${index % 6}`),
  );
  for (const id of ids) h.report(id, working);
  await h.fire();
  const gates = gatedResends(h);
  for (const id of ids) h.children.send(id, message(`to-${id}`))(undefined);
  await h.fire();
  expect(gates.inFlight()).toBe(16);
  h.clock.now += 60_000;
  await h.fire();
  expect(gates.inFlight()).toBe(16);

  for (let round = 0; round < 3; round++) {
    await gates.releaseAll();
    h.clock.now += 60_000;
    await h.fire();
  }
  expect(new Set(h.resent)).toEqual(new Set(ids.map((id) => `to-${id}`)));
  expect(gates.inFlight()).toBe(0);
  const sent = h.resent.length;
  h.clock.now += 60_000;
  await h.fire();
  expect(h.resent).toHaveLength(sent);
});

it("however many messages wait for a full machine, they never crowd out another machine's", async () => {
  const h = machine();
  const busy = Array.from({ length: 70 }, (_, index) => h.add(`busy-${index}`, "busy"));
  const other = h.add("other", "other");
  for (const id of [...busy, other]) h.report(id, working);
  await h.fire();
  const gates = gatedResends(h);
  for (const id of busy) h.children.send(id, message(`to-${id}`))(undefined);
  await h.fire();
  expect(gates.inFlight("busy")).toBe(4);

  // More of that machine's messages are due than one batch reads, all queued ahead of this one.
  h.children.send(other, message(`to-${other}`))(undefined);
  await h.fire();
  expect(gates.inFlight("other")).toBe(1);
  expect(gates.inFlight("busy")).toBe(4);
  await gates.releaseAll();
});
