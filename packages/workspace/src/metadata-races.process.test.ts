import { spawn } from "node:child_process";
import { watch as nativeWatch } from "node:fs";
import { filesystem } from "./index.ts";
import { expect, test } from "vitest";
import { join } from "node:path";
import { batches, exec, fixture } from "./test-support.ts";

test("a newly selected excludes source captures native edits beyond the inventory cut", async () => {
  const first = await fixture();
  const second = await fixture();
  await first.file("rules", "a.ts\n");
  await second.file("rules", "");
  const cut = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let armed = false;
  let inventoryRead = false;
  let root = "";
  const h = await fixture(
    {
      runtime: {
        spawn(binary, args, options) {
          const child = spawn(binary, args, options);
          if (armed && args.includes("--non-matching"))
            child.stdout?.once("data", () => {
              inventoryRead = true;
            });
          return child;
        },
      },
      filesystem: {
        ...filesystem,
        async realpath(path) {
          const resolved = await filesystem.realpath(path);
          // Pause filesystem validation after real Git has classified the file.
          if (inventoryRead && resolved === root) {
            inventoryRead = false;
            armed = false;
            cut.resolve();
            await resume.promise;
          }
          return resolved;
        },
      },
    },
    true,
  );
  root = h.service.root;
  await h.file("a.ts", "untracked");
  await exec("git", [
    "-C",
    h.root,
    "config",
    "core.excludesFile",
    join(first.service.root, "rules"),
  ]);
  const events = batches();
  const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  let observer: ReturnType<typeof nativeWatch> | undefined;
  try {
    expect(subscription.mode).toBe("native");
    armed = true;
    await exec("git", [
      "-C",
      h.root,
      "config",
      "core.excludesFile",
      join(second.service.root, "rules"),
    ]);
    await cut.promise;
    const delivered = events.next("a.ts", "deleted");
    const nativeEdit = new Promise<void>((resolve) => {
      observer = nativeWatch(second.service.root, (_event, filename) => {
        if (filename === "rules") resolve();
      });
    });
    await second.file("rules", "a.ts\n");
    await nativeEdit;
    await new Promise<void>((resolve) => setImmediate(resolve));
    resume.resolve();
    await delivered;
    expect(events.history.flat().filter((change) => change.path === "a.ts")).toEqual([
      { path: "a.ts", kind: "created" },
      { path: "a.ts", kind: "deleted" },
    ]);
    // Later edits must also arrive through the rebound native source.
    const restored = events.next("a.ts", "created");
    await second.file("rules", "");
    expect(await restored).toContainEqual({ path: "a.ts", kind: "created" });
  } finally {
    resume.resolve();
    observer?.close();
    await subscription.dispose();
  }
});
