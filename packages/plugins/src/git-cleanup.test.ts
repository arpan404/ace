import { join } from "node:path";
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
