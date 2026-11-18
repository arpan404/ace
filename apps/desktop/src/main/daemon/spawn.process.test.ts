import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { daemonLaunchPolicy, systemLaunchPort } from "./launch-priority.ts";
import { spawnDaemon } from "./spawn.ts";
import { decodeLoginPathLine } from "@ace/service/login-path";
import { z } from "zod";

const roots: string[] = [];
/** The lines the daemon wrote to its home's launch log so far. */
async function launchLog(home: string): Promise<string[]> {
  const text = await readFile(join(home, "daemon-start.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("reports a daemon process that could not be started as exited, with the reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
  roots.push(root);
  const child = spawnDaemon({
    home: root,
    // The daemon's directory is gone, so Node emits `error` (ENOENT) and never `exit`.
    resources: { entry: join(root, "missing", "ace.mjs"), packaged: false },
    path: "",
    version: "0.0.0",
    env: {},
    report: () => {},
  });
  const exit = await new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  expect(exit).toEqual([null, null, expect.stringContaining("ENOENT")]);
});

it("writes the daemon's output to its home's launch log, never through the app, and reports its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
  roots.push(root);
  const entry = join(root, "ace.mjs");
  await writeFile(
    entry,
    [
      'process.stdout.write("Daemon listening\\nsecond ");',
      'process.stdout.write("line\\n");',
      'process.stderr.write("A newer version of ace wrote this data");',
      "process.exitCode = 65;",
    ].join("\n"),
  );
  const reported: string[] = [];
  const child = spawnDaemon({
    home: root,
    resources: { entry, node: process.execPath, packaged: false },
    path: "",
    version: "0.0.0",
    env: {},
    report: (line) => reported.push(line),
  });
  const exit = await new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  expect(exit).toEqual([65, null]);
  expect(await launchLog(root)).toEqual([
    "Daemon listening",
    "second line",
    "A newer version of ace wrote this data",
  ]);
  expect(reported).toEqual([]);
});

it.runIf(process.platform === "darwin")(
  "runs the daemon's event loop at the user-interactive priority on macOS, still signalled as the daemon",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
    roots.push(root);
    const entry = join(root, "ace.mjs");
    // The daemon stand-in reports its own main-thread priority, then waits to be stopped.
    await writeFile(
      entry,
      [
        'import { execFileSync } from "node:child_process";',
        'const pri = execFileSync("/bin/ps", ["-o", "pri=", "-p", String(process.pid)]);',
        'console.log("priority " + String(pri).trim());',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const policy = daemonLaunchPolicy(systemLaunchPort());
    await policy.ready();
    const child = spawnDaemon({
      home: root,
      resources: { entry, node: process.execPath, packaged: false },
      path: "",
      version: "0.0.0",
      env: {},
      report: () => {},
      prioritize: policy.wrap,
    });
    const exit = new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
    try {
      await vi.waitFor(async () => expect(await launchLog(root)).toContain("priority 46"), {
        timeout: 10_000,
      });
    } finally {
      child.kill("SIGTERM");
    }
    // taskpolicy replaced itself with the daemon, so the signal reaches the daemon itself.
    expect(await exit).toEqual([null, "SIGTERM"]);
  },
);

it("a daemon spawned on a saved PATH gets the login shell's PATH on stdin exactly, bundled tools first", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
  roots.push(root);
  const entry = join(root, "ace.mjs");
  // The daemon stand-in reports what it started with, then the line the app sends it.
  await writeFile(
    entry,
    [
      "console.log(JSON.stringify({ pending: process.env.ACE_LOGIN_PATH_PENDING, path: process.env.PATH }));",
      'let text = "";',
      'process.stdin.setEncoding("utf8").on("data", (chunk) => (text += chunk));',
      'process.stdin.on("end", () => console.log(JSON.stringify({ line: text })));',
    ].join("\n"),
  );
  const login = Promise.withResolvers<string>();
  const output = async () => (await launchLog(root)).map((line): unknown => JSON.parse(line));
  const child = spawnDaemon({
    home: root,
    resources: { entry, node: process.execPath, packaged: false, binDirectory: "/bundled" },
    path: "/saved/bin",
    loginPath: login.promise,
    version: "0.0.0",
    env: { PATH: "/usr/bin" },
    report: () => {},
  });
  const exit = new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  await vi.waitFor(async () =>
    expect(await output()).toContainEqual({
      // What the daemon needs to ask the login shell itself, as this app would.
      pending: JSON.stringify({ prefix: "/bundled", inherited: "/usr/bin" }),
      path: `/bundled${delimiter}/saved/bin`,
    }),
  );
  const fresh = `/My Tools/bin${delimiter}/odd\nfolder ${delimiter}/saved/bin`;
  login.resolve(fresh);
  expect(await exit).toEqual([0, null]);
  const lines = await output();
  expect(lines).toHaveLength(2);
  const { line } = z.object({ line: z.string() }).parse(lines[1]);
  expect(line.split("\n")).toHaveLength(2);
  expect(decodeLoginPathLine(line)).toBe(`/bundled${delimiter}${fresh}`);
});

it("the daemon keeps running and logging after the app that started it exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
  roots.push(root);
  const entry = join(root, "ace.mjs");
  // The daemon stand-in says when its stdin ends, and keeps writing.
  await writeFile(
    entry,
    [
      'process.stdin.on("end", () => console.log("stdin ended"));',
      "process.stdin.resume();",
      "let tick = 0;",
      "setInterval(() => console.log(`tick ${tick++}`), 50);",
    ].join("\n"),
  );
  // The app: spawns the daemon, still owing it the login shell's PATH, and exits at once.
  const app = join(root, "app.mjs");
  await writeFile(
    app,
    [
      `import { spawnDaemon } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "spawn.ts")).href)};`,
      "const child = spawnDaemon({",
      `  home: ${JSON.stringify(root)},`,
      `  resources: { entry: ${JSON.stringify(entry)}, node: process.execPath, packaged: false },`,
      '  path: "",',
      "  loginPath: new Promise(() => {}),",
      '  version: "0.0.0",',
      "  env: {},",
      "  report: () => {},",
      "});",
      "console.log(JSON.stringify({ pid: child.pid }));",
      "process.exit(0);",
    ].join("\n"),
  );
  const launched = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [app], { timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
  const { pid } = z.object({ pid: z.number() }).parse(JSON.parse(launched.trim()));
  try {
    // Its stdin closing with the app is harmless: it goes on, and asks the login shell itself.
    await vi.waitFor(async () => expect(await launchLog(root)).toContain("stdin ended"), {
      timeout: 10_000,
    });
    const ticks = (await launchLog(root)).filter((line) => line.startsWith("tick")).length;
    await vi.waitFor(
      async () =>
        expect((await launchLog(root)).filter((line) => line.startsWith("tick")).length).toBe(
          ticks + 5,
        ),
      { timeout: 10_000 },
    );
    expect(() => process.kill(pid, 0)).not.toThrow();
    // Its own process group: a signal to the app's group never reaches it.
    if (process.platform !== "win32") expect(() => process.kill(-pid, 0)).not.toThrow();
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});
