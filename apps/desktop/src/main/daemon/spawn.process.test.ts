import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnDaemon } from "./spawn.ts";

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
