import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { PluginManager, gitRuntime } from "./index.ts";
import { fixture } from "./test-support.ts";

test("timeout cleanup rejection remains an observed operation failure", async () => {
  const f = await fixture();
  let manager: PluginManager | undefined;
  const failures: unknown[] = [];
  const observed = (error: unknown) => failures.push(error);
  process.on("unhandledRejection", observed);
  try {
    const command = await nodeBinary(
      f.root,
      "git-standin",
      "process.stdout.write('ready'); setInterval(() => {}, 1000);",
    );
    const runtime = gitRuntime();
    const ready = Promise.withResolvers<void>();
    let expire: (() => void) | undefined;
    manager = await PluginManager.open({
      root: join(f.root, "isolated"),
      now: () => 0,
      id: () => "cleanup",
      git: {
        ...runtime,
        command,
        spawn(options) {
          const child = runtime.spawn(options);
          child.stdout.once("data", () => ready.resolve());
          return {
            ...child,
            async stop() {
              await child.stop();
              throw new Error("Inspection unavailable");
            },
          };
        },
        schedule(callback) {
          expire = callback;
          return () => {};
        },
      },
    });
    const operation = manager.prepare({ repository: f.repo, ref: "main", name: "sample" });
    const rejected = expect(operation).rejects.toThrow("Git operation timed out");
    await ready.promise;
    if (!expire) throw new Error("Missing timer");
    expire();
    await rejected;
    await setImmediate();
    expect(failures).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", observed);
    manager?.close();
    await f.close();
  }
});

import { windowsGitStandIn } from "./test-support.ts";

test.runIf(process.platform === "win32")(
  "on Windows timeout cleanup rejection remains an observed operation failure",
  async () => {
    const f = await fixture();
    let manager: PluginManager | undefined;
    const failures: unknown[] = [];
    const observed = (error: unknown) => failures.push(error);
    process.on("unhandledRejection", observed);
    try {
      const standIn = await windowsGitStandIn(
        f.root,
        "git-standin",
        "process.stdout.write('ready'); setInterval(() => {}, 1000);",
      );
      const runtime = gitRuntime();
      const ready = Promise.withResolvers<void>();
      let expire: (() => void) | undefined;
      manager = await PluginManager.open({
        root: join(f.root, "isolated"),
        now: () => 0,
        id: () => "cleanup",
        git: {
          ...runtime,
          spawn(options) {
            const child = runtime.spawn(standIn(options));
            child.stdout.once("data", () => ready.resolve());
            return {
              ...child,
              async stop() {
                await child.stop();
                throw new Error("Inspection unavailable");
              },
            };
          },
          schedule(callback) {
            expire = callback;
            return () => {};
          },
        },
      });
      const operation = manager.prepare({ repository: f.repo, ref: "main", name: "sample" });
      const rejected = expect(operation).rejects.toThrow("Git operation timed out");
      await ready.promise;
      if (!expire) throw new Error("Missing timer");
      expire();
      await rejected;
      await setImmediate();
      expect(failures).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", observed);
      manager?.close();
      await f.close();
    }
  },
);

test.runIf(process.platform === "win32")(
  "on Windows releasing a plugin Git folder waits out a handle another process still holds",
  async () => {
    const f = await fixture();
    try {
      const folder = join(f.root, "private-git");
      await mkdir(folder);
      await writeFile(join(folder, "held"), "x");
      // A process keeps the file open without delete sharing for a moment, as a just-ended
      // Git helper's handles can.
      const holder = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('held');setTimeout(()=>fs.closeSync(fd),400);",
          join(folder, "held"),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await once(holder.stdout, "data");
      await gitRuntime().release(folder);
      await expect(access(folder)).rejects.toMatchObject({ code: "ENOENT" });
      await once(holder, "exit");
    } finally {
      await f.close();
    }
  },
);
