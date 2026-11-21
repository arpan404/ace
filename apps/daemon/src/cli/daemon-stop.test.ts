import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessListing } from "@ace/provider-kit/process-listing";
import type { TreeIo } from "@ace/provider-kit/process-tree";
import { afterEach, expect, test, vi } from "vitest";
import { RUN_MARKER_FILE } from "../run-marker.ts";
import { parseArgs } from "./args.ts";
import { stopCommand } from "./daemon-stop.ts";

/*
 * `ace stop` against an older daemon: one that answers the stop request and writes its receipt,
 * but leaves its process running. Its process lives behind a fake tree seam, so no real pid is
 * ever signalled; the endpoint is a real local HTTP server.
 */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

const DAEMON_PID = 2_147_000_001;

/** `receiptAfterMs`: how long after the request its cleanup's receipt is written. */
async function oldDaemonHome(receiptAfterMs = 0) {
  const home = await mkdtemp(join(tmpdir(), "ace-stop-old-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const server: Server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ stopping: true, receiptId: "receipt-1" }));
      // The receipt says cleanup finished; the process itself keeps running.
      await delay(receiptAfterMs);
      await writeFile(
        join(home, "daemon-shutdown.json"),
        JSON.stringify({ id: "receipt-1", state: "succeeded", at: 1 }),
      );
    })();
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await writeFile(join(home, "daemon-endpoint"), `http://127.0.0.1:${address.port}/`);
  await writeFile(join(home, "daemon-token"), "a".repeat(64));
  await writeFile(
    join(home, RUN_MARKER_FILE),
    JSON.stringify({ state: "running", pid: DAEMON_PID, startedAt: 1 }),
  );
  return home;
}

/**
 * A tree seam that knows only the old daemon's process, which ends on SIGTERM alone,
 * `exitMs` after it.
 */
function oldDaemonIo(platform: NodeJS.Platform = "darwin", exitMs = 0) {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  const io: TreeIo = {
    platform,
    lister: () => () => [],
    identity: (pid) =>
      pid === DAEMON_PID && alive ? { start: "daemon-start", parent: 1, group: pid } : undefined,
    kill(pid, signal) {
      if (pid !== DAEMON_PID) throw new Error(`signalled a stranger: ${pid}`);
      signals.push(signal);
      if (signal === "SIGTERM")
        setTimeout(() => {
          alive = false;
        }, exitMs);
    },
    wait: (milliseconds) => delay(milliseconds),
  };
  // The rest of the machine, as the sweep sees it: nothing.
  const listing: ProcessListing = {
    platform: "darwin",
    lister: () => () => [],
    all: () => [],
    info: () => undefined,
    environment: () => undefined,
    arguments: () => undefined,
    groupMembers: () => [],
  };
  return { io, listing, signals };
}

/** Runs `ace stop` with `timeout`; what it printed, or the failure it threw. */
async function stop(home: string, timeout: string, seam: ReturnType<typeof oldDaemonIo>) {
  let printed = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown, ...rest: unknown[]) => {
    printed += String(chunk);
    const done = rest.find((value) => typeof value === "function");
    if (typeof done === "function") done();
    return true;
  });
  cleanups.push(() => {
    process.exitCode = 0;
  });
  const started = performance.now();
  const outcome = await stopCommand(
    parseArgs(["stop", "--json", "--timeout", timeout]),
    home,
    seam.io,
    seam.listing,
  ).then(
    () => ({ printed: JSON.parse(printed) as unknown }),
    (error: unknown) => ({ failure: error }),
  );
  return { ...outcome, took: performance.now() - started };
}

test("ace stop ends an older daemon that sends its receipt but keeps running, within --timeout", async () => {
  const seam = oldDaemonIo();
  const outcome = await stop(await oldDaemonHome(), "1500ms", seam);
  expect(outcome).toMatchObject({ printed: { stopped: true } });
  expect(seam.signals).toEqual(["SIGTERM"]);
  expect(outcome.took).toBeLessThan(1_800);
});

test("on Windows too, an older daemon left running after its receipt is ended within --timeout", async () => {
  const seam = oldDaemonIo("win32");
  const outcome = await stop(await oldDaemonHome(), "1500ms", seam);
  expect(outcome).toMatchObject({ printed: { stopped: true } });
  expect(seam.signals).toEqual(["SIGTERM"]);
  expect(outcome.took).toBeLessThan(1_800);
});

test("a receipt that comes only in the fallback's slice never leaves the fallback without time", async () => {
  // 2 s: the fallback's slice is the last 500 ms. The receipt comes 1.8 s in, and the daemon
  // takes 300 ms to exit once signalled: a fallback started then could never be seen through.
  const seam = oldDaemonIo("darwin", 300);
  const outcome = await stop(await oldDaemonHome(1_800), "2s", seam);
  // Said as unconfirmed, as the receipt never came in time, never as a daemon left running.
  expect(outcome).toMatchObject({
    failure: { outcome: "uncertain", message: expect.stringContaining("unconfirmed") },
  });
  expect(seam.signals).toEqual([]);
  expect(outcome.took).toBeLessThan(2_300);
});
