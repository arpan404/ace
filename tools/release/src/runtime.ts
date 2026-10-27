import { spawn } from "node:child_process";
import { readFile, readdir, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Store, readConfig } from "@ace/daemon";
import { accessRequest } from "@ace/daemon/client-access";
import { InstalledRelease, DaemonHealth } from "@ace/protocol";
import { openModelStorage } from "@ace/models";
import { NotificationService } from "@ace/notify";
import {
  BoundedLog,
  runSupervisor,
  localService,
  runProcess,
  checked,
  releaseFetch,
  checkRelease,
  applyUpdate,
  recoverUpdate,
  type UpdatePorts,
  syncTree,
  syncDirectory,
  atomicPointer,
  releasePointer,
  withInstallLock,
  durableJson,
  renderLauncher,
  prepareDaemonHome,
  planUpdateLaunch,
} from "@ace/service";
import { fileURLToPath } from "node:url";
import { rename } from "node:fs/promises";
import { CMD_LAUNCHER, retrySharing, ServiceEnvironment } from "@ace/service";
import { recoveryDelay } from "@ace/service";
import { finished } from "node:stream/promises";
import { bundledDesktopApp, daemonDirectory, desktopUpdateCli } from "./desktop-update.ts";
// Build replaces this constant. A source checkout cannot authenticate a public release.
export const RELEASE_PUBLIC_KEY = "__ACE_RELEASE_PUBLIC_KEY__";
const sleep = () => new Promise<void>((r) => setTimeout(r, 1000));
const dataDir = () => readConfig().dataDir;
const Connection = z.object({
  origin: z.url().refine((s) => {
    const u = new URL(s);
    return (
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
async function request(method: string, path: string) {
  const root = dataDir();
  const c = Connection.parse({
    origin: await readFile(join(root, "daemon-endpoint"), "utf8"),
    token: await readFile(join(root, "daemon-token"), "utf8"),
  });
  return accessRequest(c.origin, path, { token: c.token, method });
}
export async function migrateCheck(path: string) {
  const store = new Store(join(path, "events.sqlite"));
  store.close();
  const notifications = new NotificationService({
    path: join(path, "notifications.sqlite"),
    now: Date.now,
    jitter: Math.random,
    transport: {
      async send() {
        return "retry";
      },
    },
  });
  await notifications.close();
  const modelStorage = openModelStorage(join(path, "models.sqlite"));
  modelStorage.load();
  await modelStorage.close();
  for (const name of await readdir(path))
    if (name.endsWith(".sqlite")) {
      const db = new DatabaseSync(join(path, name));
      try {
        if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
          throw new Error("Migration integrity check failed");
      } finally {
        db.close();
      }
    }
}
function updatePorts(): UpdatePorts {
  const manager = localService(dataDir());
  return {
    now: Date.now,
    wait: sleep,
    maintenance: (method) => request(method, "/v1/maintenance"),
    stop: async () => {
      await manager.perform("stop");
    },
    start: async () => {
      await manager.perform("start");
    },
    async health(version) {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if (DaemonHealth.parse(await request("GET", "/v1/status")).version === version)
            return true;
        } catch {}
        await sleep();
      }
      return false;
    },
    migrate: async (candidate, copy) => {
      await checked(runProcess, join(candidate, "bin/node"), [
        join(candidate, "ace.mjs"),
        "migrate-check",
        copy,
      ]);
      // The check ran the candidate's node.exe; Windows can hold its files a moment after exit.
      if (process.platform === "win32") await renamable(candidate);
    },
  };
}
export async function updateCli(args: string[]) {
  const command = z.enum(["check", "apply", "recover"]).parse(args[0]);
  if (args.length > 2 || (args[1] !== undefined && (args[1] !== "--drain" || command !== "apply")))
    throw new Error("Usage: ace update check|apply [--drain]|recover");
  // Inside the desktop app the app owns the update, daemon included (ADR 0091).
  const desktop = await bundledDesktopApp(daemonDirectory(import.meta.url));
  if (desktop) {
    await desktopUpdateCli(command, desktop, (line) => process.stdout.write(`${line}\n`));
    return;
  }
  const root = dataDir(),
    ports = updatePorts();
  if (command !== "check") {
    await withInstallLock(root, async () => {
      await recoverUpdate(root, root, ports);
      // A crash after committing can leave only the in-memory admission barrier.
      await ports.maintenance("DELETE");
    });
    if (command === "recover") return;
  }
  const installed = InstalledRelease.parse(
    JSON.parse(await readFile(join(root, await releasePointer(root), "release.json"), "utf8")),
  );
  const feed =
    installed.channel === "stable"
      ? "https://api.github.com/repos/arpan404/ace/releases/latest"
      : "https://api.github.com/repos/arpan404/ace/releases/tags/preview";
  const release = await checkRelease(
    releaseFetch,
    feed,
    installed.target,
    installed.channel,
    RELEASE_PUBLIC_KEY,
  );
  if (command === "check") {
    process.stdout.write(JSON.stringify(release.manifest) + "\n");
    return;
  }
  await applyUpdate({
    root,
    dataDir: root,
    bytes: release.bytes,
    signature: release.signature,
    publicKey: RELEASE_PUBLIC_KEY,
    archiveUrl: release.url,
    fetcher: releaseFetch,
    drain: args[1] === "--drain",
    ports,
  });
}
export async function installArtifact(
  artifact: string,
  installService: (root: string) => Promise<unknown> = (root) =>
    localService(root).perform("install"),
) {
  const manifest = InstalledRelease.parse(
    JSON.parse(await readFile(join(artifact, "release.json"), "utf8")),
  );
  if (manifest.target !== `${process.platform}-${process.arch}`)
    throw new Error("Artifact target mismatch");
  const root = dataDir();
  // Settle the home's format first, so an older home is set aside before the release lands.
  prepareDaemonHome(root);
  await withInstallLock(root, async () => {
    if (existsSync(join(root, "current")))
      throw new Error("Already installed. Use ace update apply.");
    const target = `releases/${manifest.version}-${manifest.target}`;
    await mkdir(join(root, "releases"), { recursive: true });
    await cp(artifact, join(root, target), { recursive: true, dereference: false });
    await durableJson(join(root, target, "release.json"), manifest);
    await mkdir(join(root, "bin"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "bin/ace"), renderLauncher(root), { mode: 0o755 });
    // Windows runs the launcher by its extension: bin\ace.cmd.
    if (process.platform === "win32")
      await rename(join(root, "bin/ace"), join(root, "bin", CMD_LAUNCHER));
    await syncTree(join(root, target));
    await syncDirectory(join(root, "releases"));
    await atomicPointer(join(root, "current"), target);
  });
  await installService(root);
}
export async function supervise() {
  const root = dataDir();
  await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
  const diagnostics = new BoundedLog(join(root, "logs/daemon.log"));
  const diagnosticErrors = new BoundedLog(join(root, "logs/daemon.err.log"));
  let saturated = false;
  diagnostics.on("error", () => {});
  diagnosticErrors.on("error", () => {});
  const report = (error: unknown) => {
    if (saturated || diagnosticErrors.destroyed) return;
    saturated = !diagnosticErrors.write(
      (error instanceof Error ? error.message : "Supervisor failure").slice(0, 4096) + "\n",
    );
    if (saturated)
      diagnosticErrors.once("drain", () => {
        saturated = false;
      });
  };
  diagnostics.write("Supervisor starting\n");
  try {
    const manifest = InstalledRelease.parse(
      JSON.parse(await readFile(join(root, await releasePointer(root), "release.json"), "utf8")),
    );

    process.exitCode = await runSupervisor({
      output: new BoundedLog(join(root, "logs/output.log")),
      errors: new BoundedLog(join(root, "logs/error.log")),
      dailyUpdates: process.env.ACE_AUTO_UPDATE === "1",
      journalPending: () => existsSync(join(root, "update.json")),
      schedule(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      subscribeStop(stop) {
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        return () => {
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
        };
      },
      spawnDaemon: () =>
        spawn(process.execPath, [fileURLToPath(new URL("./ace.mjs", import.meta.url)), "start"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ACE_VERSION: manifest.version,
            ACE_MAINTENANCE: existsSync(join(root, "update.json")) ? "1" : "0",
          },
        }),
      launchUpdate(command) {
        const launch = planUpdateLaunch({
          platform: process.platform,
          env: process.env,
          node: process.execPath,
          args: [fileURLToPath(new URL("./ace.mjs", import.meta.url)), "update", command],
          root,
        });
        return spawn(launch.command, launch.args, {
          stdio: "ignore",
          detached: launch.detached,
        });
      },
      report,
    });
  } catch (error) {
    report(error);
    throw error;
  } finally {
    await Promise.allSettled(
      [diagnostics, diagnosticErrors].map(async (stream) => {
        const done = finished(stream, { cleanup: true });
        stream.end();
        await done;
      }),
    );
  }
}
export async function releaseCommand(args: string[]): Promise<boolean> {
  if (args[0] === "update") await updateCli(args.slice(1));
  else if (args[0] === "supervise" && process.platform === "win32") await superviseTask();
  else if (args[0] === "supervise") await supervise();
  else if (args[0] === "migrate-check" && args.length === 2 && args[1])
    await migrateCheck(resolve(args[1]));
  else if (args[0] === "install-artifact" && args.length === 2 && args[1])
    await installArtifact(resolve(args[1]));
  else return false;
  return true;
}

/** Waits until nothing holds `directory` open, so the updater's rename of it succeeds. */
async function renamable(directory: string): Promise<void> {
  await retrySharing(() => rename(directory, `${directory}.probe`));
  await retrySharing(() => rename(`${directory}.probe`, directory));
}

const TaskEnvironment = ServiceEnvironment.extend({
  ACE_HOME: z.string().min(1),
  PATH: z.string(),
  ACE_AUTO_UPDATE: z.enum(["0", "1"]),
}).strict();

/**
 * `supervise` under Windows' Task Scheduler task. A task has no environment of its own, so the
 * service environment `ace service install` captured is applied first. Task Scheduler restarts
 * only a task that fails to start, so a daemon that exits with an error is restarted here, as
 * launchd's KeepAlive and systemd's Restart=always do; a clean exit (`POST /v1/stop`) ends it.
 */
async function superviseTask(): Promise<void> {
  const root = dataDir();
  const saved = await readFile(join(root, "service", "environment.json"), "utf8").catch(
    () => undefined,
  );
  if (saved !== undefined) {
    const environment = TaskEnvironment.parse(JSON.parse(saved));
    if (resolve(environment.ACE_HOME).toLowerCase() !== resolve(root).toLowerCase())
      throw new Error("The service environment names another ACE_HOME");
    Object.assign(process.env, environment);
  }
  await untilCleanExit({
    // supervise() records its own failures in logs/daemon.err.log.
    async once() {
      process.exitCode = undefined;
      await supervise();
      return typeof process.exitCode === "number" ? process.exitCode : undefined;
    },
    wait: (ms) => new Promise((wake) => setTimeout(wake, ms)),
  });
}

/**
 * Runs the supervisor until it ends with exit code 0. A daemon that exited with an error is
 * restarted after 15 seconds; a supervisor that failed (a missing release, an unreadable home)
 * is retried with the update recovery's backoff, as an ended task would never be restarted.
 */
export async function untilCleanExit(ports: {
  once(): Promise<number | undefined>;
  wait(ms: number): Promise<void>;
}): Promise<void> {
  for (let failures = 0; ;) {
    let delay: number;
    try {
      if ((await ports.once()) === 0) return;
      failures = 0;
      delay = 15_000;
    } catch {
      delay = recoveryDelay(failures);
      failures = Math.min(failures + 1, 6);
    }
    await ports.wait(delay);
  }
}
