import { dirname } from "node:path";
import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { spawnSupervised } from "@ace/provider-kit/process";
import { Helper } from "./index.ts";
import { deferred, ids } from "./testing/support.ts";
import { windowsFixture } from "./testing/windows-fixture.ts";

it("an unterminated oversized POSIX helper reply kills the process before readline grows further", async () => {
  const exited = deferred<unknown>();
  const failed = deferred<Error>();
  const helper = await Helper.open({
    command: process.execPath,
    args: ["-e", 'process.stdin.once("data", () => process.stdout.write("x".repeat(1048577)));'],
    platform: "darwin",
    nextId: ids(),
    spawn: (options) => {
      const child = spawnSupervised(options);
      void child.exited.then(exited.resolve);
      return child;
    },
    onFrame: () => {},
    onFailure: failed.resolve,
  });
  try {
    await expect(helper.request({ op: "permissions" })).rejects.toThrow("exited");
    await exited.promise;
    expect(await failed.promise).toBeInstanceOf(Error);
  } finally {
    await helper.close();
  }
});
it("spawn failure removes the private Unix frame socket directory", async () => {
  let path: string | undefined;
  const helper = await Helper.open({
    command: "/no-such-screen-helper",
    platform: "darwin",
    nextId: ids(),
    onFrame: () => {},
    onFailure: () => {},
    spawn: (options) => {
      path = options.args?.at(-1);
      return spawnSupervised(options);
    },
  });
  await expect(helper.request({ op: "permissions" })).rejects.toThrow();
  await helper.close();
  if (!path) throw new Error("Missing socket path");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
});
it("the injected snapshot deadline rejects a missing frame and releases capture demand", async () => {
  const deadlines = new Set<() => void>();
  const f = await windowsFixture({
    env: { NO_FRAMES: "1" },
    scheduler: {
      schedule(run, _ms) {
        deadlines.add(run);
        return () => {
          deadlines.delete(run);
        };
      },
    },
  });
  try {
    const session = await f.start();
    const reading = f.manager.captureScreenshot(session.sessionId);
    const rejection = expect(reading).rejects.toThrow("Screenshot timed out");
    await f.manager.targets();
    for (const run of deadlines) run();
    await rejection;
    expect((await f.manager.targets()).windows[0]?.title).toMatch(/:false$/);
  } finally {
    await f.close();
  }
});
