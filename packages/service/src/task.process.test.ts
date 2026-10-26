import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { create } from "tar";
import {
  applyUpdate,
  hashFile,
  MaintenanceGate,
  atomicPointer,
  pointer,
  planTask,
  renderLauncher,
  runProcess,
  TaskService,
  CMD_LAUNCHER,
  type TaskPlan,
} from "./index.ts";
import { assertCompatibleTask } from "./compatibility.ts";
import { CLI_SHIM_MARKER } from "./home.ts";

// Windows only: Task Scheduler, the ace.cmd launcher and Windows file sharing.
const windows = describe.runIf(process.platform === "win32");
const run = promisify(execFile);
const target = `win32-${process.arch}`;
const release = `releases/1.0.0-${target}`;
const token = "a".repeat(64);

/** Stands in for the release's ace.mjs: a daemon that answers `POST /v1/stop`. */
const daemon = `import { createServer } from "node:http";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const home = process.env.ACE_HOME;
const log = (line) => appendFileSync(join(home, "fixture.log"), line + "\\n");
if (process.argv[2] === "service") {
  const { serviceCommand } = await import(process.env.ACE_TEST_SERVICE_MODULE);
  process.stdout.write(JSON.stringify(await serviceCommand(home, process.argv.slice(3))));
  process.exit(0);
}
if (process.argv[2] === "update") {
  // Stands in for the updater a supervisor starts: it runs until the test ends it.
  writeFileSync(join(home, "updater.pid"), String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.argv[2] !== "supervise") {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), home }));
  process.exit(0);
} else {
const server = createServer((request, response) => {
  if (existsSync(join(home, "ignore-stop"))) {
    response.statusCode = 503;
    response.end();
  } else if (request.method === "POST" && request.url === "/v1/stop" && request.headers.authorization === "Bearer ${token}") {
    log("stop-request");
    response.end("{}", () => process.exit(0));
  } else {
    response.statusCode = 404;
    response.end();
  }
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(home, "daemon-token"), "${token}");
  writeFileSync(join(home, "daemon-endpoint"), "http://127.0.0.1:" + server.address().port);
  writeFileSync(join(home, "daemon.pid"), String(process.pid));
  writeFileSync(join(home, "daemon-lock"), JSON.stringify({ pid: process.pid, id: "fixture" }));
  log("started");
  if (existsSync(join(home, "spawn-updater")))
    spawn(process.execPath, [process.argv[1], "update", "apply"], { detached: true, stdio: "ignore" }).unref();
});
}
`;

let scratch = "";
let node = "";
let sid = "";
const roots: string[] = [];
const tasks: string[] = [];
beforeAll(async () => {
  if (process.platform !== "win32") return;
  scratch = await mkdtemp(join(tmpdir(), "ace-task-"));
  // One copy of node.exe on the temp volume; every home hard-links it.
  node = join(scratch, "node.exe");
  await copyFile(process.execPath, node);
  const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  sid = z.string().parse(/"(S-1-[\d-]+)"\s*$/.exec(stdout.trim())?.[1]);
});
afterEach(async () => {
  for (const name of tasks.splice(0)) {
    await runProcess("schtasks.exe", ["/End", "/TN", name]);
    await runProcess("schtasks.exe", ["/Delete", "/TN", name, "/F"]);
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20 })),
  );
});
afterAll(async () => {
  // A scanner may still hold the copied node.exe; the runner's temp is discarded anyway.
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 20 }).catch(() => {});
});

/** An installed home as install.ps1 leaves it: release, pointer file and ace.cmd. */
async function home(parent = scratch): Promise<string> {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "home-"));
  roots.push(root);
  await mkdir(join(root, release, "bin"), { recursive: true });
  await link(node, join(root, release, "bin", "node.exe"));
  await writeFile(join(root, release, "ace.mjs"), daemon);
  await writeFile(
    join(root, release, "release.json"),
    JSON.stringify({ version: "1.0.0", target, channel: "stable" }),
  );
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", CMD_LAUNCHER), renderLauncher(root));
  await atomicPointer(join(root, "current"), release);
  return root;
}

function service(root: string, plan: TaskPlan) {
  return new TaskService(plan, {
    run: runProcess,
    preflight: () => assertCompatibleTask(plan, root),
    requestStop: async () => {
      try {
        const origin = await readFile(join(root, "daemon-endpoint"), "utf8");
        const response = await fetch(`${origin}/v1/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

function taskPlan(root: string): TaskPlan {
  const name = `ace-test-${randomUUID().slice(0, 8)}`;
  tasks.push(`\\${name}`);
  return planTask({
    dataDir: root,
    executable: join(root, "bin", CMD_LAUNCHER),
    path: process.env.PATH ?? "",
    user: sid,
    systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    name,
    environment: { ACE_LOG_LEVEL: "warn" },
  });
}

async function until<T>(read: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < ms;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const Chain = z.array(z.object({ name: z.string(), window: z.number(), command: z.string() }));
/** The process, its ancestors up to the console host, and each one's main window handle. */
async function ancestry(pid: number) {
  const script = `$p = ${pid}; $out = @()
while ($p) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $proc) { break }
  $live = Get-Process -Id $p -ErrorAction SilentlyContinue
  $out += [pscustomobject]@{ name = $proc.Name; window = [int64]$live.MainWindowHandle; command = [string]$proc.CommandLine }
  if ($proc.Name -eq 'conhost.exe' -or $proc.Name -eq 'svchost.exe') { break }
  $p = $proc.ParentProcessId
}
ConvertTo-Json -Compress -InputObject @($out)`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", script]);
  return Chain.parse(JSON.parse(stdout));
}

windows("Windows login task", () => {
  test("the task runs the home's launcher with no console window and stops through the daemon", async () => {
    const root = await home();
    const task = taskPlan(root);
    const manager = service(root, task);
    await expect(manager.perform("install")).resolves.toEqual({ active: true });
    const pid = Number(await until(() => readFile(join(root, "daemon.pid"), "utf8")));
    const chain = await ancestry(pid);
    expect(chain.map((step) => step.name.toLowerCase())).toContain("conhost.exe");
    expect(chain.filter((step) => step.window !== 0)).toEqual([]);
    await expect(
      readFile(join(root, "service", "environment.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ ACE_HOME: root, ACE_LOG_LEVEL: "warn", ACE_AUTO_UPDATE: "1" });

    await expect(manager.perform("status")).resolves.toEqual({ active: true });
    await expect(manager.perform("stop")).resolves.toEqual({ active: false });
    expect(await readFile(join(root, "fixture.log"), "utf8")).toContain("stop-request");

    await rm(join(root, "daemon.pid"));
    await expect(manager.perform("start")).resolves.toEqual({ active: true });
    await until(() => readFile(join(root, "daemon.pid"), "utf8"));
    // An unchanged reinstall leaves the running daemon alone.
    await expect(manager.perform("install")).resolves.toEqual({ active: true });
    expect((await readFile(join(root, "fixture.log"), "utf8")).match(/stop-request/g)).toHaveLength(
      1,
    );

    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
    expect((await runProcess("schtasks.exe", ["/Query", "/TN", task.name])).code).not.toBe(0);
    await expect(readFile(task.file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // A second removal is a no-op.
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });

  test("a task by ace's name that ace did not register is refused, never replaced", async () => {
    const root = await home();
    const task = taskPlan(root);
    const created = await runProcess("schtasks.exe", [
      "/Create",
      "/TN",
      task.name,
      "/TR",
      "cmd.exe /c exit 0",
      "/SC",
      "ONCE",
      "/ST",
      "23:59",
      "/F",
    ]);
    expect(created.code).toBe(0);
    const manager = service(root, task);
    await expect(manager.perform("status")).rejects.toThrow(/Incompatible or legacy/);
    await expect(manager.perform("install")).rejects.toThrow(/Incompatible or legacy/);
    await expect(manager.perform("uninstall")).rejects.toThrow(/Incompatible or legacy/);
    const kept = await runProcess("schtasks.exe", ["/Query", "/TN", task.name, "/XML"]);
    expect(kept.stdout).toContain("cmd.exe");
  });

  test("a daemon that never answers is ended with every process the task started", async () => {
    const root = await home();
    const task = taskPlan(root);
    const manager = service(root, task);
    await manager.perform("install");
    const pid = Number(await until(() => readFile(join(root, "daemon.pid"), "utf8")));
    await writeFile(join(root, "ignore-stop"), "");
    await expect(manager.perform("stop")).resolves.toEqual({ active: false });
    expect(alive(pid)).toBe(false);
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });

  test("a changed task record is refused before Task Scheduler is asked anything", async () => {
    const root = await home();
    const task = taskPlan(root);
    const manager = service(root, task);
    await manager.perform("install");
    await writeFile(task.file, task.content.replace("supervise", "start"));
    await expect(manager.perform("stop")).rejects.toThrow(/Incompatible or legacy/);
    await writeFile(task.file, task.content);
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });
});

windows("Windows home layout", () => {
  test("ace.cmd runs the release that current names and refuses any other pointer", async () => {
    const root = await home();
    const launcher = join(root, "bin", CMD_LAUNCHER);
    const invoke = () =>
      run("cmd.exe", ["/d", "/s", "/c", `""${launcher}" status --json"`], {
        windowsVerbatimArguments: true,
      });
    const { stdout } = await invoke();
    expect(JSON.parse(stdout)).toEqual({ args: ["status", "--json"], home: root });
    for (const bad of [
      "releases/../x",
      "releases/1.0.0-x&echo injected",
      "bin",
      `${release}\r\nbin`,
    ]) {
      await writeFile(join(root, "current"), bad);
      await expect(invoke()).rejects.toMatchObject({ code: 1 });
    }
  });

  test("uninstall run through ace.cmd removes the release it runs from once it has exited", async () => {
    const root = await home();
    const launcher = join(root, "bin", CMD_LAUNCHER);
    const { stdout } = await run(
      "cmd.exe",
      ["/d", "/s", "/c", `""${launcher}" service uninstall"`],
      {
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          ACE_TEST_SERVICE_MODULE: pathToFileURL(join(import.meta.dirname, "index.ts")).href,
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({ active: false });
    await expect(pointer(join(root, "current"))).resolves.toBeUndefined();
    await until(async () =>
      existsSync(join(root, "releases")) || existsSync(launcher) ? undefined : true,
    );
  });

  test("swapping current waits for a reader that holds the pointer without sharing it", async () => {
    const root = await home();
    const current = join(root, "current");
    // FileShare.Read only: a rename over the file fails until the reader lets go.
    const holder = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$f = [System.IO.File]::Open('${current}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep -Milliseconds 1500; $f.Close()`,
    ]);
    const released = new Promise((resolve) => holder.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("exit", () => reject(new Error("Holder exited before locking")));
    });
    await atomicPointer(current, "releases/1.1.0-" + target);
    await expect(pointer(current)).resolves.toBe("releases/1.1.0-" + target);
    await released;
  });
});

windows("Windows standalone update", () => {
  test("an update commits and keeps an old release that a running program still holds", async () => {
    const root = await home();
    const stale = `releases/0.9.0-${target}`;
    await mkdir(join(root, stale), { recursive: true });
    await writeFile(join(root, stale, "helper.exe"), "loaded");
    const input = join(root, "input");
    await mkdir(input);
    await writeFile(join(input, "marker"), "candidate");
    const archive = join(root, "candidate.tar.gz");
    await create({ cwd: input, file: archive, gzip: true }, ["marker"]);
    const payload = await readFile(archive);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = Buffer.from(
      JSON.stringify({
        version: "1.1.0",
        target,
        channel: "stable",
        archive: `ace-1.1.0-${target}.tar.gz`,
        bytes: payload.length,
        sha256: await hashFile(archive),
      }),
    );
    const gate = new MaintenanceGate(() => 0);
    // Stands in for a loaded .exe: open without delete sharing until the test ends.
    const holder = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$f = [System.IO.File]::Open('${join(root, stale, "helper.exe")}', 'Open', 'Read', 'Read'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`,
    ]);
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("exit", () => reject(new Error("Holder exited before locking")));
      });
      await expect(
        applyUpdate({
          root,
          dataDir: root,
          bytes,
          signature: sign(null, bytes, privateKey).toString("base64"),
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
          archiveUrl: "https://example.com/artifact",
          fetcher: async () => new Response(payload),
          drain: false,
          ports: {
            now: () => 0,
            wait: async () => {},
            maintenance: async (method) =>
              method === "POST" ? gate.enter() : method === "DELETE" ? gate.leave() : gate.status(),
            stop: async () => {},
            start: async () => {},
            health: async () => true,
            migrate: async () => {},
          },
        }),
      ).resolves.toBe("updated");
      await expect(pointer(join(root, "current"))).resolves.toBe(`releases/1.1.0-${target}`);
      await expect(pointer(join(root, "previous"))).resolves.toBe(release);
      expect(await readFile(join(root, `releases/1.1.0-${target}`, "marker"), "utf8")).toBe(
        "candidate",
      );
      await expect(readFile(join(root, "update.json"))).rejects.toMatchObject({ code: "ENOENT" });
      // Pruning is best effort: the held release stays for the next update to remove.
      expect(await readFile(join(root, stale, "helper.exe"), "utf8")).toBe("loaded");
    } finally {
      const released = new Promise((resolve) => holder.once("exit", resolve));
      holder.stdin.end("\n");
      await released;
    }
  });
});

/** A daemon that is not the task's: started from a node.exe outside the home's releases. */
const foreignDaemon = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.ACE_HOME;
const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/v1/stop") response.end("{}", () => process.exit(0));
  else response.end();
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(home, "daemon-token"), "${token}");
  writeFileSync(join(home, "daemon-endpoint"), "http://127.0.0.1:" + server.address().port);
  writeFileSync(join(home, "daemon-lock"), JSON.stringify({ pid: process.pid, id: "foreign" }));
  process.stdout.write("listening\\n");
});
`;

windows("Windows login task stop", () => {
  test("a stop that has to end the task leaves the updater its supervisor started running", async () => {
    const root = await home();
    const task = taskPlan(root);
    const manager = service(root, task);
    await writeFile(join(root, "spawn-updater"), "");
    await manager.perform("install");
    const daemonPid = Number(await until(() => readFile(join(root, "daemon.pid"), "utf8")));
    const updater = Number(await until(() => readFile(join(root, "updater.pid"), "utf8")));
    try {
      await writeFile(join(root, "ignore-stop"), "");
      await expect(manager.perform("stop")).resolves.toEqual({ active: false });
      expect(alive(daemonPid)).toBe(false);
      expect(alive(updater)).toBe(true);
    } finally {
      if (alive(updater)) process.kill(updater);
    }
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });

  test("ace service stop never asks a daemon from another program to stop", async () => {
    const root = await home();
    const task = taskPlan(root);
    const manager = service(root, task);
    await manager.perform("install");
    await until(() => readFile(join(root, "daemon.pid"), "utf8"));
    // The desktop app's daemon takes the home: its endpoint, token and lock replace the task's.
    const script = join(scratch, `foreign-${randomUUID().slice(0, 8)}.mjs`);
    await writeFile(script, foreignDaemon);
    const foreign = spawn(node, [script], { env: { ...process.env, ACE_HOME: root } });
    try {
      await new Promise<void>((resolve, reject) => {
        foreign.stdout.once("data", () => resolve());
        foreign.once("exit", () => reject(new Error("The other daemon exited before listening")));
      });
      await expect(manager.perform("stop")).resolves.toEqual({ active: false });
      expect(foreign.exitCode).toBeNull();
      expect(alive(z.number().parse(foreign.pid))).toBe(true);
    } finally {
      const exited = new Promise((resolve) => foreign.once("exit", resolve));
      foreign.kill();
      await exited;
    }
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });

  test("the task runs a home whose path holds ( ) & @ and ^", async () => {
    const root = await home(join(scratch, "John (Work) & Co @x^y"));
    const task = taskPlan(root);
    const manager = service(root, task);
    await expect(manager.perform("install")).resolves.toEqual({ active: true });
    await until(() => readFile(join(root, "daemon.pid"), "utf8"));
    await expect(manager.perform("stop")).resolves.toEqual({ active: false });
    expect(await readFile(join(root, "fixture.log"), "utf8")).toContain("stop-request");
    await expect(manager.perform("uninstall")).resolves.toEqual({ active: false });
  });
});

windows("Windows launcher homes", () => {
  test("ace.cmd finds a home whose path is not plain ASCII or holds cmd.exe's special characters", async () => {
    for (const parent of ["José", "Zoë 日本", "John (Work) & Co", "100% ^done"]) {
      const root = await home(join(scratch, parent));
      const launcher = join(root, "bin", CMD_LAUNCHER);
      const { stdout } = await run("cmd.exe", ["/d", "/s", "/c", `""${launcher}" status"`], {
        windowsVerbatimArguments: true,
      });
      expect(JSON.parse(stdout)).toEqual({ args: ["status"], home: root });
    }
  });
});

const UserPathValue = z.object({ value: z.string().nullable(), kind: z.string() });
/** HKCU\Environment\Path as written, variables unexpanded; values travel through env vars. */
async function userPath(next?: { value: string | null; kind: string }) {
  const write =
    next === undefined
      ? ""
      : next.value === null
        ? "$key.DeleteValue('Path', $false); "
        : "$key.SetValue('Path', $env:ACE_TEST_PATH, $env:ACE_TEST_KIND); ";
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); ${write}$v = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames'); $k = if ($null -ne $v) { $key.GetValueKind('Path').ToString() } else { 'None' }; ConvertTo-Json -Compress @{ value = $v; kind = $k }`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, ACE_TEST_PATH: next?.value ?? "", ACE_TEST_KIND: next?.kind ?? "" },
  });
  return UserPathValue.parse(JSON.parse(stdout));
}

/** `ace service uninstall` run from the home's installed release. */
const uninstall = (root: string) =>
  run(process.execPath, [join(root, release, "ace.mjs"), "service", "uninstall"], {
    env: {
      ...process.env,
      ACE_HOME: root,
      ACE_TEST_SERVICE_MODULE: pathToFileURL(join(import.meta.dirname, "index.ts")).href,
    },
  });

windows("Windows standalone uninstall and PATH", () => {
  test("uninstall takes the home's bin off the user PATH and keeps every other entry as written", async () => {
    const before = await userPath();
    const root = await home();
    const keep = `%SystemRoot%\\ace-keep-${randomUUID().slice(0, 8)}`;
    // Empty entries, spacing and the trailing separator are the person's: they stay.
    const written = `${before.value ?? ""};;${keep};${join(root, "BIN")}\\; C:\\ace tail ;`;
    try {
      await userPath({ value: written, kind: "ExpandString" });
      await uninstall(root);
      await expect(userPath()).resolves.toEqual({
        value: `${before.value ?? ""};;${keep}; C:\\ace tail ;`,
        kind: "ExpandString",
      });
    } finally {
      await userPath(before.value === null ? { value: null, kind: "" } : before);
    }
  });

  test("uninstall keeps the desktop app's ace command and its PATH entry", async () => {
    const before = await userPath();
    const root = await home();
    const shim = `@echo off\r\nrem ${CLI_SHIM_MARKER}\r\nexit /b 0\r\n`;
    // The app's command replaced the launcher; the release it ran is still there.
    await writeFile(join(root, "bin", CMD_LAUNCHER), shim);
    await rm(join(root, "current"));
    const written = `${before.value ?? ""};${join(root, "bin")}`;
    try {
      await userPath({ value: written, kind: "ExpandString" });
      expect(JSON.parse((await uninstall(root)).stdout)).toEqual({ active: false });
      await until(async () => (existsSync(join(root, "releases")) ? undefined : true));
      expect((await userPath()).value).toBe(written);
      expect(await readFile(join(root, "bin", CMD_LAUNCHER), "utf8")).toBe(shim);
    } finally {
      await userPath(before.value === null ? { value: null, kind: "" } : before);
    }
  });
});
