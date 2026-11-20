import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exitCodes } from "./cli/output.ts";
import { shutdownControl, readShutdownReceipt } from "./shutdown-receipt.ts";
import { startCli } from "./cli-test-support.ts";

/*
 * `ace stop` against a stand-in daemon: an HTTP server answering /v1/stop with a real receipt,
 * and a separate process named as the home's running daemon in its run marker, so the test
 * decides when (and whether) "the daemon" exits.
 */
const token = "1".repeat(64);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A long-lived process; `stubborn` ignores SIGTERM, as a wedged daemon would. */
function standIn(stubborn = false): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", `${stubborn ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000);`],
    { stdio: "ignore" },
  );
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return child;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function home(daemon: ChildProcess | undefined, close: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ace-stop-receipt-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const control = shutdownControl(root, { id: () => "synthetic-stop", now: () => 1000, close });
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (request.url !== "/v1/stop" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    response.once("finish", () => {
      control.start();
      server.close(() => closed.resolve());
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(control.request()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => void server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(join(root, "daemon-endpoint"), `http://127.0.0.1:${address.port}`);
  await writeFile(join(root, "daemon-token"), token);
  if (daemon?.pid)
    await writeFile(
      join(root, "daemon-run.json"),
      JSON.stringify({ state: "running", pid: daemon.pid, startedAt: 1 }),
    );
  return { root, closed: closed.promise };
}

test.each(["succeeded", "failed"] as const)(
  "ace stop waits for cleanup and reports a %s shutdown receipt after the daemon exits",
  async (state) => {
    const daemon = standIn();
    const cleanup = Promise.withResolvers<void>();
    cleanups.push(() => cleanup.resolve());
    const { root, closed } = await home(daemon, () => cleanup.promise);
    const cli = startCli(root, ["stop", "--json", "--timeout", "5s"]);
    cleanups.push(() => void cli.child.kill("SIGKILL"));
    let completed = false;
    void cli.exited.then(() => {
      completed = true;
    });
    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(completed).toBe(false);
    expect(readShutdownReceipt(root)?.state).toBe("pending");
    if (state === "failed") cleanup.reject(new Error("synthetic resource cleanup failure"));
    else cleanup.resolve();
    daemon.kill("SIGTERM");
    const output = await cli.exited;
    expect(output.code, output.stderr).toBe(state === "succeeded" ? 0 : 1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      stopped: state === "succeeded",
      receipt: { id: "synthetic-stop", state },
    });
  },
);

test("ace stop says the daemon is still running, and fails, when its process outlives the receipt", async () => {
  const daemon = standIn(true);
  // Another home's daemon: never this stop's to touch.
  const other = standIn();
  const { root } = await home(daemon, async () => {});
  const output = await startCli(root, ["stop", "--json", "--timeout", "2s"]).exited;
  expect(output.code).toBe(exitCodes.failed);
  expect(output.stdout + output.stderr).toContain(`still running (pid ${daemon.pid})`);
  expect(running(daemon)).toBe(true);
  expect(running(other)).toBe(true);
}, 20_000);

test("ace stop never says stopped when it can't find the daemon's process to check", async () => {
  const { root } = await home(undefined, async () => {});
  const output = await startCli(root, ["stop", "--json", "--timeout", "2s"]).exited;
  expect(output.code).toBe(exitCodes.uncertain);
  expect(output.stdout).not.toContain('"stopped":true');
});
