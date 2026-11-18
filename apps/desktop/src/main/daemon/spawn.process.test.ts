import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { daemonLaunchPolicy, systemLaunchPort } from "./launch-priority.ts";
import { spawnDaemon } from "./spawn.ts";
import { decodeLoginPathLine } from "@ace/service/login-path";
import { z } from "zod";

const roots: string[] = [];
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
    onOutput: () => {},
  });
  const exit = await new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  expect(exit).toEqual([null, null, expect.stringContaining("ENOENT")]);
});

it("passes on each output line with its stream, including a last line without a newline", async () => {
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
  const output: [string, string][] = [];
  const child = spawnDaemon({
    home: root,
    resources: { entry, node: process.execPath, packaged: false },
    path: "",
    version: "0.0.0",
    env: {},
    onOutput: (line, stream) => output.push([stream, line]),
  });
  const exit = await new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  expect(exit).toEqual([65, null]);
  // The output streams may close just after the exit.
  await vi.waitFor(() => expect(output).toHaveLength(3));
  expect(output.toSorted()).toEqual([
    ["stderr", "A newer version of ace wrote this data"],
    ["stdout", "Daemon listening"],
    ["stdout", "second line"],
  ]);
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
    const output: string[] = [];
    const policy = daemonLaunchPolicy(systemLaunchPort());
    await policy.ready();
    const child = spawnDaemon({
      home: root,
      resources: { entry, node: process.execPath, packaged: false },
      path: "",
      version: "0.0.0",
      env: {},
      onOutput: (line) => output.push(line),
      prioritize: policy.wrap,
    });
    const exit = new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
    try {
      await vi.waitFor(() => expect(output).toContain("priority 46"), { timeout: 10_000 });
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
  const output: unknown[] = [];
  const child = spawnDaemon({
    home: root,
    resources: { entry, node: process.execPath, packaged: false, binDirectory: "/bundled" },
    path: "/saved/bin",
    loginPath: login.promise,
    version: "0.0.0",
    env: { PATH: "/usr/bin" },
    onOutput: (line) => output.push(JSON.parse(line)),
  });
  const exit = new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  await vi.waitFor(() =>
    expect(output).toContainEqual({
      // What the daemon needs to ask the login shell itself, as this app would.
      pending: JSON.stringify({ prefix: "/bundled", inherited: "/usr/bin" }),
      path: `/bundled${delimiter}/saved/bin`,
    }),
  );
  const fresh = `/My Tools/bin${delimiter}/odd\nfolder ${delimiter}/saved/bin`;
  login.resolve(fresh);
  expect(await exit).toEqual([0, null]);
  await vi.waitFor(() => expect(output).toHaveLength(2));
  const { line } = z.object({ line: z.string() }).parse(output[1]);
  expect(line.split("\n")).toHaveLength(2);
  expect(decodeLoginPathLine(line)).toBe(`/bundled${delimiter}${fresh}`);
});
