import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { childGroup } from "./leader-group.ts";
import { spawnRawSupervised, stopOwnedGroups } from "./process.ts";
import { fakeMachine } from "./process-tree-test-support.ts";

const stubborn = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"];

for (const retained of [false, true])
  test(`a forced stop overtakes a polite stop's long grace${retained ? " for a retained group" : ""}`, async () => {
    const child = spawnRawSupervised({
      command: process.execPath,
      args: stubborn,
      env: process.env,
      name: "stubborn",
      ...(retained ? { killGroupOnExit: false } : {}),
    });
    // Let the child install its SIGTERM handler before anything signals it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const polite = child.stop({ graceMs: 60_000 });
    const began = performance.now();
    await stopOwnedGroups(100);
    await polite;
    expect(performance.now() - began).toBeLessThan(5_000);
    expect((await child.exited).signal).toBe("SIGKILL");
  });

test("a later, longer stop never delays the SIGKILL an earlier stop scheduled", async () => {
  const child = spawnRawSupervised({
    command: process.execPath,
    args: stubborn,
    env: process.env,
    name: "stubborn",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const began = performance.now();
  void child.stop({ graceMs: 100 });
  await child.stop({ graceMs: 60_000 });
  expect(performance.now() - began).toBeLessThan(5_000);
});

test("owner exit runs each owned group's platform destroy", async () => {
  // Negative-pid signals are invalid on Windows, so the exit hook runs the
  // destroy each owner registered instead of assuming a process group.
  const root = await mkdtemp(join(tmpdir(), "ace-owner-exit-"));
  try {
    const receipt = join(root, "destroyed");
    const moduleUrl = new URL("./process-owner.ts", import.meta.url).href;
    const script = `import {registerGroup} from ${JSON.stringify(moduleUrl)};
import {writeFileSync} from "node:fs";
registerGroup(424242, () => Promise.resolve(), {name:"test-destroy"}, () => { writeFileSync(${JSON.stringify(receipt)}, "destroyed"); });
process.exit(0);`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "ignore",
    });
    expect(await once(owner, "close")).toEqual([0, null]);
    expect(await readFile(receipt, "utf8")).toBe("destroyed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform !== "win32")(
  "a child whose start can't be read at spawn is stopped through its group only while its own handle says it is unreaped",
  async () => {
    // This test's own child, in a group of its own. The listing can read no start for it, so
    // only the child's handle can say whether its group id is still its own.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("No child");
    const exited = once(child, "exit");
    const handle: { exitCode: number | null; signalCode: string | null } = {
      exitCode: null,
      signalCode: null,
    };
    const { tree, listing } = fakeMachine({});
    const group = childGroup(pid, undefined, handle, { tree, listing });
    try {
      // The handle says the exit was heard: the group number is no longer trusted.
      handle.exitCode = 0;
      await group.signal("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode === null && child.signalCode === null).toBe(true);
      // Unreaped by its handle: the group is stopped by number.
      handle.exitCode = null;
      await group.signal("SIGTERM");
      expect((await exited)[1]).toBe("SIGTERM");
    } finally {
      child.kill("SIGKILL");
    }
  },
);
