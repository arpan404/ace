import { watch as nativeWatch } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { batches, exec, fixture } from "./test-support.ts";

test("config notifications without filenames rebind excludes sources for later native edits", async () => {
  const first = await fixture();
  const second = await fixture();
  const h = await fixture(
    {
      runtime: {
        watch(root, options, listener) {
          // Preserve real native delivery while exercising Node's missing filename contract.
          return nativeWatch(root, options, (event, filename) =>
            listener(event, options.recursive ? null : filename),
          );
        },
      },
    },
    true,
  );
  await first.file("rules", "a.ts\n");
  await second.file("rules", "");
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
  try {
    expect(subscription.mode).toBe("native");
    const visible = events.next("a.ts", "created");
    await exec("git", [
      "-C",
      h.root,
      "config",
      "core.excludesFile",
      join(second.service.root, "rules"),
    ]);
    expect(await visible).toContainEqual({ path: "a.ts", kind: "created" });
    // No further workspace writes can mask a missing subscription to the new source.
    const hidden = events.next("a.ts", "deleted");
    await second.file("rules", "a.ts\n");
    expect(await hidden).toContainEqual({ path: "a.ts", kind: "deleted" });
    const restored = events.next("a.ts", "created");
    await second.file("rules", "");
    expect(await restored).toContainEqual({ path: "a.ts", kind: "created" });
    expect(events.history.flat().every((change) => change.path === "a.ts")).toBe(true);
  } finally {
    await subscription.dispose();
  }
});
