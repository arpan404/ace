import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadFeatures, setSpadeShown, watchFeatures } from "./features-file.ts";

async function home(onTestFinished: (run: () => Promise<void>) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-features-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function watching(dir: string, onTestFinished: (run: () => void) => void) {
  const logs: { level: string; message: string }[] = [];
  const watch = await watchFeatures({
    home: dir,
    log: (level, message) => logs.push({ level, message }),
    onChange: () => {},
  });
  onTestFinished(() => watch.close());
  return { watch, logs };
}

test("with no features.json Spade is hidden", async ({ onTestFinished }) => {
  const dir = await home(onTestFinished);
  expect((await loadFeatures(dir)).flags.spade).toBe(false);
});

test('{"spade": true} shows Spade', async ({ onTestFinished }) => {
  const dir = await home(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": true}');
  expect((await loadFeatures(dir)).flags.spade).toBe(true);
});

test("editing features.json flips Spade while the watch runs", async ({ onTestFinished }) => {
  const dir = await home(onTestFinished);
  const { watch } = await watching(dir, onTestFinished);
  expect(watch.current().spade).toBe(false);
  await setSpadeShown(dir, true);
  await expect.poll(() => watch.current().spade, { timeout: 4000 }).toBe(true);
  await writeFile(join(dir, "features.json"), '{"spade": false}');
  await expect.poll(() => watch.current().spade, { timeout: 4000 }).toBe(false);
});

test("a broken features.json hides Spade with one warning, and recovers once fixed", async ({
  onTestFinished,
}) => {
  const dir = await home(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": tru');
  const { watch, logs } = await watching(dir, onTestFinished);
  expect(watch.current().spade).toBe(false);
  expect(logs.filter((each) => each.level === "warn")).toHaveLength(1);
  await writeFile(join(dir, "features.json"), '{"spade": tru ');
  await writeFile(join(dir, "features.json"), '{"spade": true}');
  await expect.poll(() => watch.current().spade, { timeout: 4000 }).toBe(true);
  expect(logs.filter((each) => each.level === "warn")).toHaveLength(1);
});

test("showing Spade keeps the file's other keys", async ({ onTestFinished }) => {
  const dir = await home(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"later": "kept", "spade": false}');
  await setSpadeShown(dir, true);
  expect(JSON.parse(await readFile(join(dir, "features.json"), "utf8"))).toEqual({
    later: "kept",
    spade: true,
  });
});

test("a replacement during watcher installation is reconciled before returning", async () => {
  let text = '{"spade":false}';
  const watch = await watchFeatures({
    home: "/test",
    log: () => {},
    onChange: () => {},
    runtime: {
      readText: async () => text,
      watch: () => {
        text = '{"spade":true}';
        return () => {};
      },
      every: () => () => {},
    },
  });
  expect(watch.current().spade).toBe(true);
  watch.close();
});

test("a change during the initial read is read again without overlapping reads", async () => {
  let changed: (() => void) | undefined;
  let release: ((text: string) => void) | undefined;
  let first = true;
  let active = 0;
  let maximum = 0;
  const pending = watchFeatures({
    home: "/test",
    log: () => {},
    onChange: () => {},
    runtime: {
      async readText() {
        active++;
        maximum = Math.max(maximum, active);
        const text = first
          ? await new Promise<string>((resolve) => {
              release = resolve;
              first = false;
            })
          : '{"spade":true}';
        active--;
        return text;
      },
      watch: (_directory, notify) => {
        changed = () => notify("features.json");
        return () => {};
      },
      every: () => () => {},
    },
  });
  changed?.();
  release?.('{"spade":false}');
  const watch = await pending;
  expect(watch.current().spade).toBe(true);
  expect(maximum).toBe(1);
  watch.close();
});
