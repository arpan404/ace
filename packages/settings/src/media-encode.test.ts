import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "./service.ts";

async function home(onTestFinished: (run: () => Promise<void>) => void, settings: object) {
  const dir = await mkdtemp(join(tmpdir(), "ace-media-encode-"));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ version: 2, settings }));
  const service = new SettingsService({ dataDir: dir });
  onTestFinished(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service };
}

test("a stored legacy media encoder reads as auto and keeps the rest of the file", async ({
  onTestFinished,
}) => {
  const { dir, service } = await home(onTestFinished, {
    "media.encode": "legacy",
    "media.delivery": "legacy",
    "beta.spade": true,
  });
  expect((await service.get("media.encode")).value).toBe("auto");
  expect((await service.get("media.delivery")).value).toBe("legacy");
  expect((await service.get("beta.spade")).value).toBe(true);
  const stored = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  expect(stored.settings["media.encode"]).toBeUndefined();
});

test("media encoding can no longer be set to legacy", async ({ onTestFinished }) => {
  const { service } = await home(onTestFinished, {});
  await expect(
    // @ts-expect-error The value is gone from the schema; a client sending it is refused.
    service.set("media.encode", "legacy", { kind: "global" }),
  ).rejects.toThrow();
  expect((await service.get("media.encode")).value).toBe("auto");
});
