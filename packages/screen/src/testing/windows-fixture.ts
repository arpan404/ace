import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenManager, type ScreenOptions } from "../index.ts";
import { ids, target } from "./support.ts";
export async function windowsFixture(overrides: Partial<ScreenOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-review-"));
  const manager = new ScreenManager({
    command: process.execPath,
    args: [new URL("./fake-helper-v2.ts", import.meta.url).pathname],
    nextId: ids(),
    platform: "win32",
    endpoint: `unix:${join(directory, "pipe")}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
    ...overrides,
  });
  await manager.enable(true);
  await manager.approve(target.bundleId, true);
  return {
    manager,
    directory,
    start: () => manager.start(target),
    async close() {
      try {
        await manager.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
