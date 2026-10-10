import { frameBatch, immediate, type NotifyBatch } from "@ace/client-react";
import { diffFile, type FileChanges, type FileDiff } from "@ace/ui-core";
import { expect, test } from "vitest";
import { createDiffService, diffKey, diffView, type Keyed } from "./diff-service.ts";

const added = (path: string, lines: number): FileChanges => ({
  path,
  changes: [
    {
      path,
      kind: "add",
      newText: `${Array.from({ length: lines }, (_, n) => `line ${n}`).join("\n")}\n`,
    },
  ],
});
const keyedFiles = (count: number, lines = 3): Keyed[] =>
  Array.from({ length: count }, (_, n) => {
    const file = added(`src/file-${n}.ts`, lines);
    return { file, key: diffKey(file) };
  });

/** Lets settled diffs reach their views. */
async function settle() {
  for (let tick = 0; tick < 3; tick++) await Promise.resolve();
}

/** A diff worker the test finishes by hand, recording the files it was asked to diff. */
function worker() {
  const asked: string[] = [];
  const waiting = new Map<string, () => void>();
  return {
    asked,
    compute: (_key: string, file: FileChanges) => {
      asked.push(file.path);
      return new Promise<FileDiff>((resolve) => {
        waiting.set(file.path, () => resolve(diffFile(file)));
      });
    },
    async finish(path?: string) {
      for (const [waitingPath, resolve] of waiting) {
        if (path !== undefined && waitingPath !== path) continue;
        waiting.delete(waitingPath);
        resolve();
      }
      await settle();
    },
  };
}

function service(compute: ReturnType<typeof worker>["compute"], batch: NotifyBatch = immediate) {
  return createDiffService({ compute, batch, maxEntries: 2, maxBytes: 4096 });
}

test("diffs stay on screen when more files are open than the cache holds", async () => {
  const diffs = worker();
  const files = keyedFiles(5);
  const view = diffView(service(diffs.compute), files);
  const stop = view.subscribe(() => {});

  await diffs.finish();
  await diffs.finish();
  expect(view.read().map((diff) => diff?.path)).toEqual(files.map(({ file }) => file.path));
  // Each file was diffed once: nothing on screen was evicted and diffed again.
  expect(diffs.asked).toHaveLength(5);
  stop();
});

test("a diff larger than the whole cache still shows while it is open", async () => {
  const diffs = worker();
  const huge = keyedFiles(1, 400);
  const view = diffView(service(diffs.compute), huge);
  const stop = view.subscribe(() => {});
  await diffs.finish();
  await diffs.finish();
  expect(view.read()[0]?.additions).toBe(400);
  expect(diffs.asked).toHaveLength(1);
  stop();
});

test("a finished diff updates only the views showing that file", async () => {
  const diffs = worker();
  const shared = service(diffs.compute);
  const [first, second] = keyedFiles(2);
  if (!first || !second) throw new Error("expected two files");
  const one = diffView(shared, [first]);
  const other = diffView(shared, [second]);
  const told: string[] = [];
  const stopOne = one.subscribe(() => told.push("one"));
  const stopOther = other.subscribe(() => told.push("other"));

  await diffs.finish(first.file.path);
  expect(told).toEqual(["one"]);
  expect(one.read()[0]?.path).toBe(first.file.path);
  expect(other.read()[0]).toBeUndefined();
  stopOne();
  stopOther();
});

test("diffs that finish within one frame reach a view as one update", async () => {
  const diffs = worker();
  const frames: (() => void)[] = [];
  const batch = frameBatch((flush) => frames.push(flush));
  const view = diffView(service(diffs.compute, batch), keyedFiles(4));
  let updates = 0;
  const stop = view.subscribe(() => updates++);

  await diffs.finish();
  expect(updates).toBe(0);
  frames.shift()?.();
  expect(updates).toBe(1);
  expect(view.read().every((diff) => diff !== undefined)).toBe(true);
  stop();
});

test("a closed view's diffs go back to the bounded cache", async () => {
  const diffs = worker();
  const shared = service(diffs.compute);
  const files = keyedFiles(4);
  const stop = diffView(shared, files).subscribe(() => {});
  await diffs.finish();
  stop();

  // The cache keeps two of them; the others are diffed again when shown again.
  const again = diffView(shared, files);
  expect(again.read().filter((diff) => diff !== undefined)).toHaveLength(2);
  const stopAgain = again.subscribe(() => {});
  await diffs.finish();
  expect(again.read().every((diff) => diff !== undefined)).toBe(true);
  expect(diffs.asked).toHaveLength(6);
  stopAgain();
});

test("folded text counts toward cache memory, but stays available while its view is open", async () => {
  const text = `${"a very long unchanged source line".repeat(8)}\n`.repeat(5_000);
  const file: FileChanges = {
    path: "folded.ts",
    changes: [{ path: "folded.ts", kind: "update", oldText: text, newText: text }],
  };
  const key = diffKey(file);
  const shared = createDiffService({
    compute: async () => diffFile(file),
    batch: immediate,
    maxEntries: 600,
    maxBytes: 4096,
  });
  const view = diffView(shared, [{ file, key }]);
  const stop = view.subscribe(() => {});
  await settle();
  expect(view.read()[0]?.rows).toHaveLength(1);
  expect(view.read()[0]?.rows[0]).toMatchObject({ kind: "fold", count: 5_000 });
  stop();
  expect(shared.peek(key, file) === undefined).toBe(true);
});
