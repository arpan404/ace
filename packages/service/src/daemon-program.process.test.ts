import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { daemonLaunches, daemonSettingsFrom, spawnDaemonRuntime } from "./daemon-program.ts";
import { shippedExecutableName } from "./process-names.ts";

// Real edge: Bun reads `.env` files from the working directory, and treats a first bare word as
// one of its own commands, only when its executable is not named `node`. Only the real runtime
// under the daemon's name shows that.
const onBun = typeof Reflect.get(globalThis, "Bun") === "object";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** How the daemon starts on `named`: its first, preferred launch. */
function namedLaunch(named: string, script: string, words: string[]) {
  const [launch] = daemonLaunches(process.execPath, named, script, words);
  if (!launch) throw new Error("no launch");
  return launch;
}

/** The running runtime under the daemon's name, and a project folder with a `.env`. */
function namedRuntime(): { named: string; project: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-program-"));
  roots.push(root);
  const named = join(root, shippedExecutableName("daemon", process.platform));
  try {
    linkSync(process.execPath, named);
  } catch {
    copyFileSync(process.execPath, named);
  }
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "ACE_PORT=not-a-port\nACE_PROBE=from-dotenv\n");
  writeFileSync(join(project, ".env.local"), "ACE_PROBE=from-dotenv-local\n");
  const script = join(root, "probe.mjs");
  writeFileSync(
    script,
    "console.log(JSON.stringify({ port: process.env.ACE_PORT ?? null, probe: process.env.ACE_PROBE ?? null, args: process.argv.slice(2) }));\n",
  );
  return { named, project, script };
}

async function output(command: string, args: string[], cwd: string): Promise<string> {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? "" } });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  await once(child, "close");
  return text.trim();
}

test.runIf(onBun)(
  "the daemon under its own name reads no .env from the folder it is started in",
  async () => {
    const { named, project, script } = namedRuntime();
    const launch = namedLaunch(named, script, ["start"]);
    expect(launch.command).toBe(named);
    const seen = JSON.parse(await output(launch.command, launch.args, project));
    expect(seen).toEqual({ port: null, probe: null, args: ["start"] });
  },
);

test.runIf(onBun)("a daemon word is the script's argument, never a command of Bun's", async () => {
  const { named, project, script } = namedRuntime();
  for (const word of ["install", "run", "test"]) {
    const launch = namedLaunch(named, script, [word]);
    const seen = JSON.parse(await output(launch.command, launch.args, project));
    expect(seen.args).toEqual([word]);
  }
});

test.runIf(onBun)(
  "the daemon runs no bunfig.toml preload from the folder it was started from",
  async () => {
    const { named, project, script } = namedRuntime();
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
    writeFileSync(join(project, "preload.mjs"), "process.env.ACE_PROBE = 'from-preload';\n");
    for (const launch of daemonLaunches(process.execPath, named, script, ["start"])) {
      // The caller's folder is where `ace open` was run; the launch says where the daemon runs.
      const seen = JSON.parse(await output(launch.command, launch.args, launch.cwd));
      expect(seen.probe).toBeNull();
    }
  },
);

test("a daemon launch takes only an absolute script, so Bun never reads it as a command", () => {
  expect(() => daemonLaunches("/rt/node", "/rt/ace-service", "ace.mjs", ["start"])).toThrow(
    /absolute/,
  );
});

test("the plain runtime keeps the arguments it always had, which Node accepts too", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-plain-"));
  roots.push(root);
  const script = join(root, "probe.mjs");
  writeFileSync(script, "process.stdout.write(process.argv.slice(2).join(' '))");
  const launches = daemonLaunches(process.execPath, process.execPath, script, ["serve", "--json"]);
  expect(launches).toHaveLength(1);
  const [plain] = launches;
  if (!plain) throw new Error("no launch");
  expect(await output(plain.command, plain.args, root)).toBe("serve --json");
});

test("the daemon starts on the plain runtime when its named one cannot be spawned", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-fallback-"));
  roots.push(root);
  const missing = join(root, shippedExecutableName("daemon", process.platform));
  const script = join(root, "probe.mjs");
  writeFileSync(script, "process.stdout.write('started')");
  const tried: string[] = [];
  const child = spawnDaemonRuntime(
    daemonLaunches(process.execPath, missing, script, []),
    (launch) => {
      tried.push(launch.command);
      return spawn(launch.command, launch.args, { stdio: "pipe" });
    },
  );
  let text = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const [code] = await once(child, "close");
  expect(tried).toEqual([missing, process.execPath]);
  expect(code).toBe(0);
  expect(text).toBe("started");
});

test("a named runtime that throws on spawn falls back to the plain one", () => {
  const tried: string[] = [];
  const plain = { pid: 7, once: () => plain };
  const child = spawnDaemonRuntime(
    [
      { command: "/rt/ace Service.exe", args: [], cwd: "/rt" },
      { command: "/rt/node.exe", args: [], cwd: "/rt" },
    ],
    (launch) => {
      tried.push(launch.command);
      if (launch.command.endsWith("ace Service.exe")) throw new Error("UNKNOWN: spawn rejected");
      return plain;
    },
  );
  expect(child).toBe(plain);
  expect(tried).toEqual(["/rt/ace Service.exe", "/rt/node.exe"]);
});

test("when the plain runtime cannot be spawned either, its own error is what fails", () => {
  expect(() =>
    spawnDaemonRuntime(
      [
        { command: "/rt/ace-service", args: [], cwd: "/rt" },
        { command: "/rt/node", args: [], cwd: "/rt" },
      ],
      (launch) => {
        throw new Error(`cannot spawn ${launch.command}`);
      },
    ),
  ).toThrow("cannot spawn /rt/node");
});

test("relative daemon settings keep meaning the folder ace was started from", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-daemon-settings-"));
  roots.push(root);
  const project = join(root, "project");
  const release = join(root, "release");
  mkdirSync(project);
  mkdirSync(release);
  const script = join(release, "probe.mjs");
  writeFileSync(
    script,
    "const { resolve } = require('node:path'); process.stdout.write(JSON.stringify({ workspace: resolve(process.env.ACE_WORKSPACE_ROOT), home: resolve(process.env.ACE_HOME), url: process.env.ACE_RELAY_URL }))",
  );
  const env = daemonSettingsFrom(
    { ACE_WORKSPACE_ROOT: "./workspace", ACE_HOME: "home", ACE_RELAY_URL: "wss://relay.example" },
    project,
  );
  const [launch] = daemonLaunches(process.execPath, process.execPath, script, []);
  if (!launch) throw new Error("no launch");
  // The daemon runs in its own folder, yet the settings name the project's.
  expect(launch.cwd).toBe(release);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...env, PATH: process.env.PATH ?? "" },
  });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  await once(child, "close");
  expect(JSON.parse(text)).toEqual({
    workspace: join(project, "workspace"),
    home: join(project, "home"),
    url: "wss://relay.example",
  });
});
