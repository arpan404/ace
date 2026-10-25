import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProbeReply } from "./probe-messages.ts";
import { createProbeRunner } from "./probe-runner.ts";
import { spawnRawSupervised } from "./process.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The Windows edges, stood in for at the spawn boundary: taskkill really signals here. */
function windows() {
  const kills: { pid: number; force: boolean }[] = [];
  const assigned: number[] = [];
  let disposed = 0;
  const spawn: typeof spawnRawSupervised = (options) =>
    spawnRawSupervised({
      ...options,
      platform: "win32",
      windowsKillTree(pid, force) {
        kills.push({ pid, force });
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
      windowsJobFactory: () => ({
        assign: (pid) => assigned.push(pid),
        dispose: () => disposed++,
      }),
    });
  return { spawn, kills, assigned, disposed: () => disposed };
}

function runner(spawn: typeof spawnRawSupervised) {
  const replies: ProbeReply[] = [];
  const probe = createProbeRunner((message) => replies.push(message), spawn);
  const exit = async (id: number) => {
    await expect
      .poll(() => replies.some((reply) => reply.id === id && reply.type === "exit"))
      .toBe(true);
    return replies.find((reply) => reply.id === id && reply.type === "exit");
  };
  const pid = (id: number) => {
    const reply = replies.find((entry) => entry.id === id && entry.type === "spawned");
    return reply?.type === "spawned" ? reply.pid : undefined;
  };
  return { probe, exit, pid };
}

test("a Windows batch shim probe runs through cmd.exe inside a kill-on-close job", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-probe-cmd-"));
  directories.push(root);
  await writeFile(join(root, "cmd.exe"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(join(root, "cmd.exe"), 0o755);
  const edges = windows();
  const { probe, exit, pid } = runner(edges.spawn);
  probe.handle({
    type: "run",
    id: 1,
    command: "C:\\tools\\agent.cmd",
    args: ["--version"],
    env: { PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
    maxBytes: 65536,
  });
  const reply = await exit(1);
  expect(reply).toMatchObject({ code: 0, reason: "exit" });
  expect(reply?.type === "exit" ? reply.stdout.split("\n").slice(0, 3) : []).toEqual([
    "/d",
    "/s",
    "/c",
  ]);
  const spawned = pid(1);
  expect(spawned).toBeDefined();
  expect(edges.assigned).toEqual([spawned]);
  // The tree is killed when its leader exits, and the job handle is released.
  expect(edges.kills).toContainEqual({ pid: spawned, force: true });
  expect(edges.disposed()).toBeGreaterThan(0);
});

test("stopping a Windows probe kills its whole tree", async () => {
  const edges = windows();
  const { probe, exit, pid } = runner(edges.spawn);
  probe.handle({
    type: "run",
    id: 2,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: {},
    maxBytes: 65536,
  });
  await expect.poll(() => pid(2)).toBeDefined();
  probe.handle({ type: "stop", id: 2 });
  expect(await exit(2)).toMatchObject({ reason: "stopped" });
  expect(edges.kills.map((kill) => kill.pid)).toContain(pid(2));
});
