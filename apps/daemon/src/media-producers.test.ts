import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "@ace/settings";
import { expect, it, onTestFinished } from "vitest";
import { followMediaEncode } from "./media-producers.ts";

async function settings() {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-media-encode-"));
  const service = new SettingsService({ dataDir });
  onTestFinished(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return service;
}

async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("media.encode is legacy until the person sets it to auto, and every change is followed", async () => {
  const service = await settings();
  const seen: string[] = [];
  const stop = await followMediaEncode(service, (encode) => void seen.push(encode));
  expect(seen).toEqual(["legacy"]);
  await service.set("media.encode", "auto", { kind: "global" });
  await until(() => seen.length === 2);
  await service.set("media.encode", "legacy", { kind: "global" });
  await until(() => seen.length === 3);
  expect(seen).toEqual(["legacy", "auto", "legacy"]);
  stop();
  await service.set("media.encode", "auto", { kind: "global" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(seen).toHaveLength(3);
});

it("a saved auto applies at start", async () => {
  const service = await settings();
  await service.set("media.encode", "auto", { kind: "global" });
  const seen: string[] = [];
  const stop = await followMediaEncode(service, (encode) => void seen.push(encode));
  onTestFinished(stop);
  expect(seen).toEqual(["auto"]);
});
