import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsStore } from "./settings-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ace-desktop-settings-"));
  roots.push(path);
  return path;
}

test("saved settings survive a restart", async () => {
  const path = join(await root(), "nested", "settings.json");
  const store = new SettingsStore(path);
  await store.update({ openAtLogin: true });
  await store.update({ preventSleep: true });
  expect(new SettingsStore(path).get()).toMatchObject({ openAtLogin: true, preventSleep: true });
});

test("a failed save changes nothing, and later saves still reach the disk", async () => {
  const dir = await root();
  // A file where the settings directory should be: creating the directory fails.
  const blocker = join(dir, "userData");
  await writeFile(blocker, "");
  const path = join(blocker, "settings.json");
  const store = new SettingsStore(path);
  const heard: boolean[] = [];
  store.onChange((settings) => heard.push(settings.openAtLogin));

  await expect(store.update({ openAtLogin: true })).rejects.toThrow();
  expect(store.get().openAtLogin).toBe(false);
  expect(heard).toEqual([]);

  await rm(blocker);
  await store.update({ preventSleep: true });
  expect(store.get()).toMatchObject({ openAtLogin: false, preventSleep: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    openAtLogin: false,
    preventSleep: true,
  });
  expect(heard).toEqual([false]);
});
