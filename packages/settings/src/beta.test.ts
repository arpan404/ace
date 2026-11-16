import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { betaOnAtRest, foldLegacySpadeFlag } from "./beta.ts";
import { fileIO } from "./io.ts";
import { SettingsService } from "./service.ts";

/**
 * A home whose settings file runs `meanwhile` once, just before the next read of it once armed:
 * another writer (`ace features off spade` with no daemon, an older ace) acting at that moment.
 */
async function racedHome(onTestFinished: (run: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), "ace-beta-race-"));
  let meanwhile: (() => Promise<void>) | undefined;
  const settings = new SettingsService({
    dataDir: dir,
    io: {
      ...fileIO,
      async read(path) {
        const run = path.endsWith("settings.json") ? meanwhile : undefined;
        meanwhile = undefined;
        await run?.();
        return fileIO.read(path);
      },
    },
  });
  onTestFinished(async () => {
    await settings.close();
    await rm(dir, { recursive: true, force: true });
  });
  await settings.get("beta.spade");
  return {
    dir,
    settings,
    arm(run: () => Promise<void>) {
      meanwhile = run;
    },
  };
}

async function home(onTestFinished: (run: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), "ace-beta-"));
  const settings = new SettingsService({ dataDir: dir });
  onTestFinished(async () => {
    await settings.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, settings };
}

const exists = (path: string) =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

test("both beta features are off in a new home", async ({ onTestFinished }) => {
  const { dir, settings } = await home(onTestFinished);
  expect(await betaOnAtRest(dir, "spade")).toBe(false);
  expect(await betaOnAtRest(dir, "marketplace")).toBe(false);
  expect((await settings.get("beta.spade")).value).toBe(false);
  expect((await settings.get("beta.marketplace")).value).toBe(false);
});

test("a beta switch persists in the global settings and reads back without a service", async ({
  onTestFinished,
}) => {
  const { dir, settings } = await home(onTestFinished);
  await settings.set("beta.marketplace", true, { kind: "global" });
  expect(await betaOnAtRest(dir, "marketplace")).toBe(true);
  const again = new SettingsService({ dataDir: dir });
  onTestFinished(() => again.close());
  expect((await again.get("beta.marketplace")).value).toBe(true);
});

test("a beta switch can't be turned on by a workspace", async ({ onTestFinished }) => {
  const { dir, settings } = await home(onTestFinished);
  await expect(
    settings.set("beta.spade", true, { kind: "workspace", workspace: dir }),
  ).rejects.toThrow("global");
});

test("features.json showing Spade turns Beta's Spade on once and leaves the file", async ({
  onTestFinished,
}) => {
  const { dir, settings } = await home(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": true}');
  expect(await betaOnAtRest(dir, "spade")).toBe(true);

  expect(await foldLegacySpadeFlag(settings, dir)).toBe(true);
  expect((await settings.get("beta.spade")).value).toBe(true);
  expect(await exists(join(dir, "features.json"))).toBe(false);

  // Turned off afterwards, it stays off: the old flag is gone.
  await settings.set("beta.spade", false, { kind: "global" });
  expect(await foldLegacySpadeFlag(settings, dir)).toBe(false);
  expect(await betaOnAtRest(dir, "spade")).toBe(false);
});

test("a choice already made in Beta wins over the old flag, which is still taken out", async ({
  onTestFinished,
}) => {
  const { dir, settings } = await home(onTestFinished);
  await settings.set("beta.spade", false, { kind: "global" });
  await writeFile(join(dir, "features.json"), '{"spade": true, "later": "kept"}');
  expect(await betaOnAtRest(dir, "spade")).toBe(false);

  expect(await foldLegacySpadeFlag(settings, dir)).toBe(false);
  expect((await settings.get("beta.spade")).value).toBe(false);
  expect(JSON.parse(await readFile(join(dir, "features.json"), "utf8"))).toEqual({
    later: "kept",
  });
});

test("a broken features.json is left alone and shows nothing", async ({ onTestFinished }) => {
  const { dir, settings } = await home(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": tru');
  expect(await betaOnAtRest(dir, "spade")).toBe(false);
  expect(await foldLegacySpadeFlag(settings, dir)).toBe(false);
  expect(await readFile(join(dir, "features.json"), "utf8")).toBe('{"spade": tru');
});

test("an off saved by another writer while the old flag moves in is never overwritten", async ({
  onTestFinished,
}) => {
  const { dir, settings, arm } = await racedHome(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": true}');
  arm(() =>
    writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ version: 2, settings: { "beta.spade": false } }),
    ),
  );
  await foldLegacySpadeFlag(settings, dir);
  expect(await betaOnAtRest(dir, "spade")).toBe(false);
});

test("keys another writer adds to features.json while the flag moves in are kept", async ({
  onTestFinished,
}) => {
  const { dir, settings, arm } = await racedHome(onTestFinished);
  await writeFile(join(dir, "features.json"), '{"spade": true}');
  arm(() => writeFile(join(dir, "features.json"), '{"spade": true, "later": "kept"}'));
  await foldLegacySpadeFlag(settings, dir);
  expect(JSON.parse(await readFile(join(dir, "features.json"), "utf8"))).toMatchObject({
    later: "kept",
  });
  expect((await settings.get("beta.spade")).value).toBe(true);
});
