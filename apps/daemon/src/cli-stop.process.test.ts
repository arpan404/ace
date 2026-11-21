import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { z } from "zod";
import { EscapeeJournal } from "@ace/provider-kit/escapee-journal";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exitCodes } from "./cli/output.ts";
import { shutdownControl, readShutdownReceipt } from "./shutdown-receipt.ts";
import { startCli } from "./cli-test-support.ts";
import { holdsConnection } from "./peer-process.ts";

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

async function home(daemon: ChildProcess | undefined, close: () => Promise<void>, owner?: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-stop-receipt-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const control = shutdownControl(root, { id: () => "synthetic-stop", now: () => 1000, close });
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (request.url !== "/v1/stop" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    // The stop request's body (its caller chain) is read, as the daemon reads it.
    request.resume();
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
      JSON.stringify({
        state: "running",
        pid: daemon.pid,
        startedAt: 1,
        ...(owner ? { owner } : {}),
      }),
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
  const began = performance.now();
  const output = await startCli(root, ["stop", "--json", "--timeout", "1s"]).exited;
  // One deadline governs every wait: past --timeout, the stop reports instead of waiting on.
  // (Allowing for the CLI's own start; a 2 s floor after SIGTERM would overrun this.)
  expect(performance.now() - began).toBeLessThan(2_500);
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

/**
 * A stand-in daemon's family, all its own descendants: an updater-like process with no marker,
 * a kept one, another home's daemon (with a provider of its own) that inherited this run's
 * marker, and one plainly marked process of this run.
 */
async function family(run: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-stop-family-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const otherHome = join(root, "home-b");
  const otherDaemon = join(otherHome, "release/apps/daemon/src/cli.ts");
  await mkdir(join(otherHome, "release/apps/daemon/src"), { recursive: true });
  await mkdir(`${otherHome}-none`, { recursive: true });
  await writeFile(
    otherDaemon,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.env.ACE_HOME + "/provider", String(provider.pid));',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const script = join(root, "family.mjs");
  const pids = join(root, "pids.json");
  await writeFile(
    script,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const [out, run, otherDaemon, otherHome] = process.argv.slice(2);",
      'const idle = ["-e", "setInterval(() => {}, 1000)"];',
      "const base = { ...process.env };",
      "delete base.ACE_PROCESS_OWNER;",
      "delete base.ACE_PROCESS_KEEP;",
      'const start = (args, env) => { const child = spawn(process.execPath, args, { stdio: "ignore", detached: true, env }); child.unref(); return child.pid; };',
      "writeFileSync(out, JSON.stringify({",
      "  updater: start(idle, base),",
      '  kept: start(idle, { ...base, ACE_PROCESS_OWNER: run, ACE_PROCESS_KEEP: "1" }),',
      '  otherDaemon: start([otherDaemon, "start"], { ...base, ACE_PROCESS_OWNER: run, ACE_HOME: otherHome }),',
      "  marked: start(idle, { ...base, ACE_PROCESS_OWNER: run }),",
      // Provider helpers that only claim protection: the variable, or a daemon's command line.
      '  claimsKept: start(idle, { ...base, ACE_PROCESS_OWNER: run, ACE_PROCESS_KEEP: "1" }),',
      '  looksLikeADaemon: start([otherDaemon, "start"], { ...base, ACE_PROCESS_OWNER: run, ACE_HOME: otherHome + "-none" }),',
      "}));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const daemon = spawn(process.execPath, [script, pids, run, otherDaemon, otherHome], {
    stdio: "ignore",
  });
  const recorded = () => {
    try {
      const value = z
        .object({
          updater: z.number(),
          kept: z.number(),
          otherDaemon: z.number(),
          marked: z.number(),
          claimsKept: z.number(),
          looksLikeADaemon: z.number(),
        })
        .parse(JSON.parse(readFileSync(pids, "utf8")));
      return {
        ...value,
        otherProvider: Number(readFileSync(join(otherHome, "provider"), "utf8")),
        imposterProvider: Number(readFileSync(join(`${otherHome}-none`, "provider"), "utf8")),
      };
    } catch {
      return undefined;
    }
  };
  cleanups.push(() => {
    // Only the processes this family recorded, and the stand-in itself.
    for (const pid of Object.values(recorded() ?? {})) if (alive(pid)) process.kill(pid, "SIGKILL");
    if (running(daemon)) daemon.kill("SIGKILL");
  });
  for (let waited = 0; !recorded() && waited < 20_000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const members = recorded();
  if (!members) throw new Error("The stand-in daemon's family did not start");
  // Home B's daemon is one by its home's run marker, naming its pid and kernel start.
  const other = processIdentity(members.otherDaemon);
  if (!other) throw new Error("Home B's daemon is not running");
  await writeFile(
    join(otherHome, "daemon-run.json"),
    JSON.stringify({ state: "running", pid: other.pid, startedAt: 1, start: other.start }),
  );
  return { daemon, members };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("ace stop ends only what the run's evidence names, never its daemon's other descendants, kept processes or another home's daemon, and honours no protection only claimed", async () => {
  const run = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
  const { daemon, members } = await family(run);
  const cleanup = Promise.withResolvers<void>();
  cleanups.push(() => cleanup.resolve());
  const { root, closed } = await home(daemon, () => cleanup.promise, run);
  // The kept process, recorded as ace records one it launches to outlive it.
  const journal = new EscapeeJournal(join(root, "processes.sqlite"), run);
  journal.keep(members.kept);
  journal.close();
  const cli = startCli(root, ["stop", "--json", "--timeout", "10s"]);
  cleanups.push(() => void cli.child.kill("SIGKILL"));
  await closed;
  cleanup.resolve();
  daemon.kill("SIGTERM");
  const output = await cli.exited;
  expect(output.code, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({ stopped: true });
  // The marked process, and the helpers whose protection was only claimed (and what is below
  // the one that looked like a daemon).
  expect({
    marked: alive(members.marked),
    claimsKept: alive(members.claimsKept),
    looksLikeADaemon: alive(members.looksLikeADaemon),
    imposterProvider: alive(members.imposterProvider),
  }).toEqual({
    marked: false,
    claimsKept: false,
    looksLikeADaemon: false,
    imposterProvider: false,
  });
  expect({
    updater: alive(members.updater),
    kept: alive(members.kept),
    otherDaemon: alive(members.otherDaemon),
    otherProvider: alive(members.otherProvider),
  }).toEqual({ updater: true, kept: true, otherDaemon: true, otherProvider: true });
}, 30_000);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "the daemon tells which local process holds a request's connection, and no other",
  async () => {
    const connected = Promise.withResolvers<{ remotePort: number; localPort: number }>();
    const server = createServer((request) => {
      connected.resolve({
        remotePort: request.socket.remotePort ?? 0,
        localPort: request.socket.localPort ?? 0,
      });
      // Held open: the client keeps its end while the check runs.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const client = spawn(
      process.execPath,
      [
        "-e",
        `require("node:http").get("http://127.0.0.1:${address.port}/", { agent: false }); setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore" },
    );
    cleanups.push(() => {
      if (running(client)) client.kill("SIGKILL");
    });
    const bystander = standIn();
    const connection = await connected.promise;
    expect(await holdsConnection(client.pid ?? 0, connection)).toBe(true);
    expect(await holdsConnection(bystander.pid ?? 0, connection)).toBe(false);
  },
  20_000,
);
