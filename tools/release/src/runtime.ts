import { spawn } from "node:child_process";
import { readFile, readdir, cp, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
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
} from "@ace/service";
import { fileURLToPath } from "node:url";
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
    },
  };
}
export async function updateCli(args: string[]) {
  const command = z.enum(["check", "apply", "recover"]).parse(args[0]);
  if (args.length > 2 || (args[1] !== undefined && (args[1] !== "--drain" || command !== "apply")))
    throw new Error("Usage: ace update check|apply [--drain]|recover");
  const root = dataDir(),
    ports = updatePorts();
  if (command !== "check") {
    await withInstallLock(root, async () => {
      if (await recoverUpdate(root, root, ports)) await ports.maintenance("DELETE");
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
const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function installArtifact(artifact: string) {
  const root = dataDir();
  const manifest = InstalledRelease.parse(
    JSON.parse(await readFile(join(artifact, "release.json"), "utf8")),
  );
  if (manifest.target !== `${process.platform}-${process.arch}`)
    throw new Error("Artifact target mismatch");
  await withInstallLock(root, async () => {
    if (existsSync(join(root, "current")))
      throw new Error("Already installed. Use ace update apply.");
    const target = `releases/${manifest.version}-${manifest.target}`;
    await mkdir(join(root, "releases"), { recursive: true });
    await cp(artifact, join(root, target), { recursive: true, dereference: false });
    await durableJson(join(root, target, "release.json"), manifest);
    await mkdir(join(root, "bin"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "bin/ace"),
      `#!/bin/sh\nACE_HOME=${shell(root)}\nexport ACE_HOME\ntarget=$(readlink "$ACE_HOME/current")\ncase "$target" in releases/*) ;; *) exit 1;; esac\nartifact="$ACE_HOME/$target"\nexec "$artifact/bin/node" "$artifact/ace.mjs" "$@"\n`,
      { mode: 0o755 },
    );
    await syncTree(join(root, target));
    await syncDirectory(join(root, "releases"));
    await atomicPointer(join(root, "current"), target);
  });
  await localService(dataDir()).perform("install");
}
export async function supervise() {
  const root = dataDir();
  const manifest = InstalledRelease.parse(
    JSON.parse(readFileSync(join(root, await releasePointer(root), "release.json"), "utf8")),
  );
  await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 });
  const stdout = new BoundedLog(join(root, "logs/output.log")),
    stderr = new BoundedLog(join(root, "logs/error.log"));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./ace.mjs", import.meta.url)), "start"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ACE_VERSION: manifest.version,
        ACE_MAINTENANCE: existsSync(join(root, "update.json")) ? "1" : "0",
      },
    },
  );
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  stdout.on("error", () => child.kill("SIGTERM"));
  stderr.on("error", () => child.kill("SIGTERM"));
  let updater: ReturnType<typeof spawn> | undefined;
  const launchUpdater = (command: "apply" | "recover") => {
    if (updater) return;
    const args = [fileURLToPath(new URL("./ace.mjs", import.meta.url)), "update", command];
    updater =
      process.platform === "linux"
        ? spawn(
            "systemd-run",
            [
              "--user",
              "--unit=ace-update",
              "--collect",
              "--property=RuntimeMaxSec=1800",
              `--setenv=ACE_HOME=${root}`,
              `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
              "--",
              process.execPath,
              ...args,
            ],
            { stdio: "ignore" },
          )
        : spawn(process.execPath, args, { stdio: "ignore", detached: true });
    updater.once("error", () => {
      updater = undefined;
    });
    // External updater must survive the service stop it requests.
    updater.unref();
    updater.once("exit", () => {
      updater = undefined;
    });
  };
  const timer = setInterval(() => {
    if (process.env.ACE_AUTO_UPDATE === "1") launchUpdater("apply");
  }, 86_400_000);
  if (existsSync(join(root, "update.json"))) launchUpdater("recover");
  const stop = () => {
    clearInterval(timer);
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      clearInterval(timer);
      stdout.end();
      stderr.end();
      process.exitCode = code ?? 1;
      resolveExit();
    });
  });
}
export async function releaseCommand(args: string[]): Promise<boolean> {
  if (args[0] === "update") await updateCli(args.slice(1));
  else if (args[0] === "supervise") await supervise();
  else if (args[0] === "migrate-check" && args.length === 2 && args[1])
    await migrateCheck(resolve(args[1]));
  else if (args[0] === "install-artifact" && args.length === 2 && args[1])
    await installArtifact(resolve(args[1]));
  else return false;
  return true;
}
