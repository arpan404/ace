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

async function oldDaemonHome() {
  const home = await mkdtemp(join(tmpdir(), "ace-stop-old-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const server: Server = createServer((request, response) => {
    void (async () => {
      // The receipt says cleanup finished; the process itself keeps running.
      await writeFile(
        join(home, "daemon-shutdown.json"),
        JSON.stringify({ id: "receipt-1", state: "succeeded", at: 1 }),
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ stopping: true, receiptId: "receipt-1" }));
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

/** A tree seam that knows only the old daemon's process, which ends on SIGTERM alone. */
function oldDaemonIo() {
  const signals: NodeJS.Signals[] = [];
  let alive = true;
  const io: TreeIo = {
    platform: "darwin",
    lister: () => () => [],
    identity: (pid) =>
      pid === DAEMON_PID && alive ? { start: "daemon-start", parent: 1, group: pid } : undefined,
    kill(pid, signal) {
      if (pid !== DAEMON_PID) throw new Error(`signalled a stranger: ${pid}`);
      signals.push(signal);
      if (signal === "SIGTERM") alive = false;
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

test("ace stop ends an older daemon that sends its receipt but keeps running, within --timeout", async () => {
  const home = await oldDaemonHome();
  const { io, listing, signals } = oldDaemonIo();
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
  await expect(
    stopCommand(parseArgs(["stop", "--json", "--timeout", "1500ms"]), home, io, listing),
  ).resolves.toBeUndefined();
  expect(JSON.parse(printed)).toMatchObject({ stopped: true });
  expect(signals).toEqual(["SIGTERM"]);
  expect(performance.now() - started).toBeLessThan(1_800);
});
