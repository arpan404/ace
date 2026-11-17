import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import type { ProcessExit, SupervisedProcess } from "@ace/provider-kit/process";
import { CodexHost, type ChannelHandlers } from "./host.ts";

/** An app-server that never answers and never exits on its own. */
function silentAppServer(): SupervisedProcess {
  const exit = Promise.withResolvers<ProcessExit>();
  return {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: createInterface({ input: new PassThrough(), crlfDelay: Infinity }),
    stderr: createInterface({ input: new PassThrough(), crlfDelay: Infinity }),
    exited: exit.promise,
    signal: new AbortController().signal,
    stop: () => exit.promise,
  };
}

const survived = () => Promise.reject(new Error("Windows process tree survived its stop"));
const handlers: ChannelHandlers = {
  frame: () => {},
  notification: () => {},
  request: () => undefined,
  dropped: () => {},
  outputUncertain: () => {},
  malformed: () => {},
  stderr: () => {},
  error: () => {},
  failed: () => {},
  exited: () => {},
};

function host(scheduled: (() => void)[]) {
  return new CodexHost({
    spawn: silentAppServer,
    dedicated: false,
    initialize: {},
    graceMs: 0,
    idleMs: 1000,
    schedule: (run) => {
      scheduled.push(run);
      return () => {};
    },
    onRetired: () => {},
    platform: "win32",
    stopTree: survived,
  });
}

const warnings: string[] = [];
const unhandled: unknown[] = [];
const warn = (warning: Error) => warnings.push(warning.message);
const hear = (reason: unknown) => unhandled.push(reason);
process.on("warning", warn);
process.on("unhandledRejection", hear);
afterEach(() => {
  warnings.length = 0;
  unhandled.length = 0;
});

it("retiring a Windows host whose shells outlived the stop fails for the session waiting on it", async () => {
  await expect(host([]).retire()).rejects.toThrow("survived its stop");
});

it("an idle shared host whose tree outlived its stop is reported, and nothing is left unhandled", async () => {
  const scheduled: (() => void)[] = [];
  const shared = host(scheduled);
  // A session that gave up before the host was ready leaves it idle.
  const gaveUp = new AbortController();
  gaveUp.abort(new Error("cancelled"));
  await expect(shared.attach(handlers, gaveUp.signal)).rejects.toThrow("cancelled");
  for (const run of scheduled.splice(0)) run();
  await expect.poll(() => warnings.join("\n")).toContain("survived its stop");
  await new Promise((resolve) => setImmediate(resolve));
  expect(unhandled).toEqual([]);
  // A later awaited retire still sees that the stop was not confirmed.
  await expect(shared.retire()).rejects.toThrow("survived its stop");
});
