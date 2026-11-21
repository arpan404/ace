import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService } from "./service.ts";

test("a settings file from an older build with the media pipeline keys loads and drops them", async ({
  onTestFinished,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "ace-retired-media-"));
  const path = join(dir, "settings.json");
  await writeFile(
    path,
    [
      "{",
      '  "version": 2,',
      "  // kept through the cleanup",
      '  "settings": {',
      '    "media.encode": "legacy",',
      '    "media.delivery": "legacy",',
      '    "media.recordings": "auto",',
      '    "media.stills": "legacy",',
      '    "beta.spade": true',
      "  }",
      "}",
    ].join("\n"),
  );
  const service = new SettingsService({ dataDir: dir });
  onTestFinished(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });

  expect((await service.get("beta.spade")).value).toBe(true);
  const text = await readFile(path, "utf8");
  expect(text).not.toContain("media.");
  expect(text).toContain("// kept through the cleanup");
  expect(JSON.parse(text.replace(/^\s*\/\/.*$/m, "")).settings).toEqual({ "beta.spade": true });
});

test("the media pipeline keys can no longer be set", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "ace-retired-media-"));
  const service = new SettingsService({ dataDir: dir });
  onTestFinished(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  // @ts-expect-error The key is gone from the schema; a client sending it is refused.
  await expect(service.set("media.delivery", "auto", { kind: "global" })).rejects.toThrow();
});
