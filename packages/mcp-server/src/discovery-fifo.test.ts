import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { discoverMcpServers } from "./index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fifo() {
  const home = await mkdtemp(join(tmpdir(), "ace-mcp-fifo-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  const created = spawnSync("mkfifo", [path]);
  if (created.status !== 0) throw new Error("Could not create test FIFO");
  // Also releases the old blocking implementation after a test timeout, so RED exits cleanly.
  cleanups.push(async () => {
    try {
      const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close();
    } catch (error) {
      if (!z.object({ code: z.literal("ENXIO") }).safeParse(error).success) throw error;
    }
  });
  return { home, cwd: home, provider: "cursor" as const, configPaths: [path], path };
}
it("rejects a FIFO config without waiting for a writer", async () => {
  const options = await fifo();
  expect(await discoverMcpServers({ ...options, signal: new AbortController().signal })).toEqual({
    servers: [],
    issues: [{ source: options.path, code: "unreadable" }],
  });
});
it("settles cancellation while a FIFO config has no writer", async () => {
  const options = await fifo();
  const controller = new AbortController();
  const discovery = discoverMcpServers({ ...options, signal: controller.signal });
  controller.abort(new Error("Discovery cancelled"));
  await expect(discovery).rejects.toThrow("Discovery cancelled");
});
