import { expect, test } from "vitest";
import { createStartup } from "@/lib/startup/startup.tsx";
import { afterFirstScreen } from "./machine-pool-boot.ts";

/** A startup and an idle queue the test drives by hand. */
function boot() {
  const startup = createStartup({
    schedule: () => () => {},
    frame: (run) => {
      run();
      return () => {};
    },
  });
  const idle: (() => void)[] = [];
  const when = afterFirstScreen(startup, (run) => {
    idle.push(run);
    return () => idle.splice(idle.indexOf(run), 1);
  });
  return {
    startup,
    when,
    idle: () => idle.splice(0).forEach((run) => run()),
    firstScreen() {
      startup.dispatch({ type: "connection", state: "ready" });
      startup.shell(true);
    },
  };
}

test("other machines connect only once the first screen is up and the browser is idle", () => {
  const { when, idle, firstScreen } = boot();
  let started = 0;
  when(() => started++);
  idle();
  expect(started).toBe(0);
  firstScreen();
  expect(started).toBe(0);
  idle();
  expect(started).toBe(1);
  idle();
  expect(started).toBe(1);
});

test("a pool asked for after the first screen is up waits only for idle", () => {
  const { when, idle, firstScreen } = boot();
  firstScreen();
  let started = 0;
  when(() => started++);
  idle();
  expect(started).toBe(1);
});

test("a window closed before its first screen never starts the pool", () => {
  const { when, idle, firstScreen } = boot();
  let started = 0;
  const cancel = when(() => started++);
  cancel();
  firstScreen();
  idle();
  expect(started).toBe(0);
});
