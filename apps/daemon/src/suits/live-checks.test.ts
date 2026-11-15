import { expect, test } from "vitest";
import type { SuitLiveReport } from "@ace/protocol/suits";
import { SuitLiveChecks } from "./live-checks.ts";

/** Timers run by hand: `advance(ms)` fires whatever falls due. */
function clock() {
  let now = 0;
  const due: { at: number; run: () => void; live: boolean }[] = [];
  return {
    timers: {
      after(ms: number, run: () => void) {
        const entry = { at: now + ms, run, live: true };
        due.push(entry);
        return () => void (entry.live = false);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const entry of due.filter((each) => each.live && each.at <= now)) {
        entry.live = false;
        entry.run();
      }
    },
  };
}

const report = (checkId: string, suitId = "arcade-cabinet"): SuitLiveReport => ({
  checkId,
  suitId,
  client: "web",
  scheme: "dark",
  widths: [1280],
  problems: [],
  unchecked: [],
  screenshot: null,
});

function setup() {
  const time = clock();
  let ids = 0;
  const checks = new SuitLiveChecks(() => `check-${++ids}`, time.timers, {
    totalMs: 9000,
    graceMs: 1500,
  });
  const laptop = { name: "laptop" };
  const phone = { name: "phone" };
  let settled: SuitLiveReport[] | undefined;
  const start = (sockets: object[], signal = new AbortController().signal) =>
    checks.run("arcade-cabinet", () => sockets, signal).then((reports) => (settled = reports));
  return { time, checks, laptop, phone, start, settled: () => settled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the reports come back as soon as every asked device has answered", async () => {
  const world = setup();
  void world.start([world.laptop, world.phone]);
  world.checks.receive(world.laptop, report("check-1"));
  await flush();
  expect(world.settled()).toBeUndefined();
  world.checks.receive(world.phone, report("check-1"));
  await flush();
  expect(world.settled()).toHaveLength(2);
});

test("after the first report a silent device gets a short grace, not the whole wait", async () => {
  const world = setup();
  void world.start([world.laptop, world.phone]);
  world.time.advance(1000);
  world.checks.receive(world.laptop, report("check-1"));
  world.time.advance(1499);
  await flush();
  expect(world.settled()).toBeUndefined();
  world.time.advance(1);
  await flush();
  expect(world.settled()).toEqual([report("check-1")]);
});

test("with no answer the check gives up after the wait with no reports", async () => {
  const world = setup();
  void world.start([world.laptop]);
  world.time.advance(8999);
  await flush();
  expect(world.settled()).toBeUndefined();
  world.time.advance(1);
  await flush();
  expect(world.settled()).toEqual([]);
});

test("with no device to ask, or once the call is cancelled, it answers at once", async () => {
  const world = setup();
  void world.start([]);
  await flush();
  expect(world.settled()).toEqual([]);
  const cancel = new AbortController();
  const again = setup();
  void again.start([again.laptop], cancel.signal);
  cancel.abort();
  await flush();
  expect(again.settled()).toEqual([]);
});

test("a report from a device not asked, for another Suit, or a second one, is ignored", async () => {
  const world = setup();
  void world.start([world.laptop, world.phone]);
  world.checks.receive({ name: "stranger" }, report("check-1"));
  world.checks.receive(world.laptop, report("check-1", "quiet-ledger"));
  world.checks.receive(world.laptop, report("check-2"));
  world.checks.receive(world.laptop, report("check-1"));
  world.checks.receive(world.laptop, report("check-1"));
  world.time.advance(1500);
  await flush();
  expect(world.settled()).toEqual([report("check-1")]);
});

test("a device that disconnects is no longer waited for", async () => {
  const world = setup();
  void world.start([world.laptop, world.phone]);
  world.checks.receive(world.laptop, report("check-1"));
  world.checks.forget(world.phone);
  await flush();
  expect(world.settled()).toEqual([report("check-1")]);
});
