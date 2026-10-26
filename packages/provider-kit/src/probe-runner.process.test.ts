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

/** The Windows branch on any host: taskkill is stood in for by signalling the leader. */
const onWindows: typeof spawnRawSupervised = (options) =>
  spawnRawSupervised({
    ...options,
    platform: "win32",
    windowsKillTree(pid, force) {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    windowsJobFactory: () => undefined,
  });

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

test("a Windows batch shim probe runs through cmd.exe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-probe-cmd-"));
  directories.push(root);
  await writeFile(join(root, "cmd.exe"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  await chmod(join(root, "cmd.exe"), 0o755);
  const { probe, exit } = runner(onWindows);
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
});

test("stopping a Windows probe kills its whole tree", async () => {
  const { probe, exit, pid } = runner(onWindows);
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
});
