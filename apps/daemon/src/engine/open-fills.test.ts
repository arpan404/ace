import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Store } from "@ace/daemon";
import { OpenFills, type OpenFill } from "./open-fills.ts";

/** A fill that fails a few steps, then works; its name is not a real pass. */
function flaky(failures: number) {
  let remaining = failures;
  let done = false;
  const fill: OpenFill & { failedCalls: number } = {
    name: "probe",
    failedCalls: 0,
    step() {
      if (remaining-- > 0) throw new Error("step failed");
      done = true;
      return true;
    },
    complete: () => done,
    failed: () => void fill.failedCalls++,
  };
  return fill;
}

const opened: { close(): void }[] = [];
afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

function open() {
  const home = mkdtempSync(join(tmpdir(), "ace-open-fills-"));
  const store = new Store(join(home, "events.sqlite"));
  opened.push({
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
  return store;
}

/** Drives the driver's own tick, capturing the delay each one asks for. */
function drive(store: Store, fill: OpenFill) {
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  const fills = new OpenFills(store, [fill], () => {});
  fills.useSchedule((task, delayMs) => {
    delays.push(delayMs);
    pending = task;
    return () => {};
  });
  return {
    fills,
    delays,
    tick() {
      const task = pending;
      pending = undefined;
      task?.();
    },
  };
}

test("a fill whose step keeps failing is retried with backoff, never abandoned", () => {
  const store = open();
  const fill = flaky(2);
  const driver = drive(store, fill);
  driver.fills.start();
  driver.tick(); // fails
  driver.tick(); // fails
  driver.tick(); // works
  expect(driver.delays).toEqual([0, 250, 500]);
  expect(fill.complete()).toBe(true);
  driver.tick(); // nothing left: settles, no timer
  expect(driver.delays).toEqual([0, 250, 500]);
});

test("a fill failing three steps in a row tells its readers to fall back, and keeps retrying", () => {
  const store = open();
  const fill = flaky(3);
  const driver = drive(store, fill);
  driver.fills.start();
  driver.tick();
  driver.tick();
  driver.tick();
  expect(fill.failedCalls).toBe(1);
  driver.tick(); // the fourth step works
  expect(fill.complete()).toBe(true);
  expect(driver.delays).toEqual([0, 250, 500, 1000]);
});

test("one failed step does not stop the other fills", () => {
  const store = open();
  const broken = flaky(1000);
  let worked = false;
  const good: OpenFill = {
    name: "good",
    step() {
      worked = true;
      return true;
    },
    complete: () => false,
  };
  const fills = new OpenFills(store, [broken, good], () => {});
  expect(fills.pump()).toBe(true);
  expect(worked).toBe(true);
  expect(broken.failedCalls).toBe(0);
});
