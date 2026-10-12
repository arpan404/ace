import { join } from "node:path";
import { expect, test } from "vitest";
import { workspaceRuntime } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

test.each([
  "empty relative",
  "missing relative",
  "empty absolute",
  "empty conditional",
  "empty home",
])("%s included config changes invalidate visibility through native delivery", async (kind) => {
  const peer = await fixture();
  const h = await fixture(
    {
      runtime: {
        environment: { ...workspaceRuntime().environment, HOME: peer.service.root },
      },
    },
    true,
  );
  const extra = join(peer.service.root, "nested/extra.conf");
  const rules = join(peer.service.root, "rules");
  const target =
    kind === "empty absolute"
      ? extra
      : kind === "empty home"
        ? "~/nested/extra.conf"
        : "nested/extra.conf";
  const section =
    kind === "empty conditional" ? `[includeIf "gitdir:${h.service.root}/.git/"]` : "[include]";
  await peer.file("declaring.conf", `${section}\npath = ${target}\n`);
  if (kind !== "missing relative") await peer.file("nested/extra.conf", "");
  await peer.file("rules", "a.ts\n");
  await h.file("a.ts", "untracked");
  await exec("git", [
    "-C",
    h.root,
    "config",
    "--add",
    "include.path",
    join(peer.service.root, "declaring.conf"),
  ]);
  const events = batches();
  const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  try {
    expect(subscription.mode).toBe("native");
    const hidden = events.next("a.ts", "deleted");
    await peer.file("nested/extra.conf", `[core]\nexcludesFile = ${rules}\n`);
    expect(await hidden).toContainEqual({ path: "a.ts", kind: "deleted" });
    const restored = events.next("a.ts", "created");
    await peer.file("rules", "");
    expect(await restored).toContainEqual({ path: "a.ts", kind: "created" });
    expect(events.history.flat().every((change) => change.path === "a.ts")).toBe(true);
  } finally {
    await subscription.dispose();
  }
});
