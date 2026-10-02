import { afterEach, expect, test } from "vitest";
import { constants, openSync, writeSync, closeSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeOutput } from "@ace/provider-kit/process";
import { loadLaunchFile } from "./index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test("FIFO launch configurations reject without occupying filesystem workers", async () => {
  const base = await mkdtemp(join(tmpdir(), "ace-preview-fifo-"));
  const paths: string[] = [];
  const pending: Promise<unknown>[] = [];
  cleanup.push(async () => {
    // Cleanup cannot depend on the worker pool this regression may exhaust.
    const writers: number[] = [];
    try {
      for (const path of paths) {
        const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
        writers.push(fd);
        writeSync(fd, '{"configurations":[]}');
      }
      for (const fd of writers.splice(0)) closeSync(fd);
      await Promise.allSettled(pending);
    } finally {
      for (const fd of writers) closeSync(fd);
      await rm(base, { recursive: true, force: true });
    }
  });
  const roots = Array.from({ length: 4 }, (_, n) => join(base, String(n)));
  for (const root of roots) {
    await mkdir(join(root, ".ace"), { recursive: true });
    paths.push(join(root, ".ace", "launch.json"));
  }
  expect((await probeOutput("mkfifo", paths)).code).toBe(0);
  const ordinary = join(base, "ordinary.txt");
  await writeFile(ordinary, "filesystem responsive");
  for (const root of roots) pending.push(loadLaunchFile(root));
  // Convert rejections to values immediately; no abandoned rejection on timeout.
  const results = pending.map((operation) =>
    operation.then(
      () => "accepted FIFO",
      (error: unknown) => error,
    ),
  );
  const [errors, text] = await Promise.all([Promise.all(results), readFile(ordinary, "utf8")]);
  expect(text).toBe("filesystem responsive");
  for (const error of errors)
    expect(error).toEqual(expect.objectContaining({ message: "Preview file must be regular" }));
});
