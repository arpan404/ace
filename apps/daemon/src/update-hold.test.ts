import { expect, test } from "vitest";
import { MaintenanceGate } from "@ace/service";
import { UpdateHold } from "./update-hold.ts";

/** A gate with an update lease on a clock the test moves. */
function lease(leaseMs = 45_000) {
  let time = 0;
  const timers: { at: number; run(): void; cancelled: boolean }[] = [];
  const gate = new MaintenanceGate(() => 0);
  const hold = new UpdateHold(
    gate,
    {
      delay: (run, ms) => {
        const timer = { at: time + ms, run, cancelled: false };
        timers.push(timer);
        return () => (timer.cancelled = true);
      },
    },
    leaseMs,
  );
  const advance = (ms: number) => {
    time += ms;
    for (const timer of timers.splice(0))
      if (timer.cancelled) continue;
      else if (timer.at <= time) timer.run();
      else timers.push(timer);
  };
  return { gate, hold, advance };
}

test("an update hold nobody renews lets new work start again on its own", () => {
  const { gate, hold, advance } = lease();
  hold.renew();
  expect(gate.admit()).toBe(false);
  advance(44_000);
  expect(gate.admit()).toBe(false);
  advance(1_000);
  expect(gate.admit()).toBe(true);
});

test("a drain that keeps renewing holds admission past the lease", () => {
  const { gate, hold, advance } = lease();
  hold.renew();
  for (let poll = 0; poll < 120; poll++) {
    advance(1_000);
    hold.renew();
  }
  expect(gate.held("update")).toBe(true);
  hold.release();
  expect(gate.admit()).toBe(true);
});

test("the update's lease ending never ends the person's pause", () => {
  const { gate, hold, advance } = lease();
  gate.enter("user");
  hold.renew();
  advance(45_000);
  expect(gate.status().holds).toEqual(["user"]);
});

test("a daemon started mid-update holds until recovery, with no lease", () => {
  const { gate, hold, advance } = lease();
  hold.persist();
  hold.renew();
  advance(10 * 60_000);
  expect(gate.held("update")).toBe(true);
  hold.release();
  expect(gate.admit()).toBe(true);
});
