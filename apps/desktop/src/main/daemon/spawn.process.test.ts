import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it("passes on each output line with its stream, including a last line without a newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-spawn-"));
  roots.push(root);
  const entry = join(root, "ace.mjs");
  await writeFile(
    entry,
    [
      'process.stdout.write("Daemon listening\\nsecond ");',
      'process.stdout.write("line\\n");',
      'process.stderr.write("A newer version of ace wrote this data");',
      "process.exitCode = 65;",
    ].join("\n"),
  );
  const output: [string, string][] = [];
  const child = spawnDaemon({
    home: root,
    resources: { entry, node: process.execPath, packaged: false },
    path: "",
    version: "0.0.0",
    env: {},
    onOutput: (line, stream) => output.push([stream, line]),
  });
  const exit = await new Promise<unknown[]>((resolve) => child.onExit((...args) => resolve(args)));
  expect(exit).toEqual([65, null]);
  // The output streams may close just after the exit.
  await vi.waitFor(() => expect(output).toHaveLength(3));
  expect(output.toSorted()).toEqual([
    ["stderr", "A newer version of ace wrote this data"],
    ["stdout", "Daemon listening"],
    ["stdout", "second line"],
  ]);
});
