import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { IngestProducer } from "@ace/media/ingest-sources";
import { phoneOwner } from "@ace/media/testing/fake-delivery";
import { Resources } from "./resources.ts";
import { startMedia } from "./media.ts";
import type { ServiceContext } from "./types.ts";

/*
 * ace-media is the only encoder, so a producer that comes before the daemon has made its runtime
 * (while the binary's version is read) must wait for it rather than fail, and one whose binary
 * never answers must be told why. A fake binary stands in, named by ACE_MEDIA_PATH.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function daemonWith(script: string, settings?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "ace-media-service-"));
  const binary = join(dir, "ace-media");
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  const before = process.env.ACE_MEDIA_PATH;
  process.env.ACE_MEDIA_PATH = binary;
  const resources = new Resources();
  const logged: string[] = [];
  const context = {
    services: settings ? { settings } : {},
    id: () => "id",
    config: { dataDir: dir },
    resources,
    log: { log: (_level: string, message: string) => void logged.push(message) },
  } as unknown as ServiceContext;
  cleanups.push(async () => {
    await resources.close();
    if (before === undefined) delete process.env.ACE_MEDIA_PATH;
    else process.env.ACE_MEDIA_PATH = before;
    await rm(dir, { recursive: true, force: true });
  });
  return { media: startMedia(context), logged, dir };
}

function producer(stops: string[]): IngestProducer {
  return {
    source: "tab-1",
    kind: "tab",
    origin: { kind: "tab" },
    epoch: () => 0,
    consumers: { deliver: () => {} },
    point: () => Promise.resolve(),
    keyframe: () => {},
    stopped: (reason) => void stops.push(reason),
  };
}

it("a producer that comes while the binary's version is still being read gets a source, not a refusal", async () => {
  const { media } = await daemonWith('sleep 1; echo "ace-media 0.0.0"');
  const stops: string[] = [];
  const source = media?.add(producer(stops));
  expect(source, "added before the runtime exists").toBeDefined();
  expect(stops).toEqual([]);
  source?.close();
});

it("a binary that never answers its version leaves every producer told why, before and after", async () => {
  const { media } = await daemonWith("exit 3");
  const early: string[] = [];
  const waiting = media?.add(producer(early));
  expect(waiting).toBeDefined();
  await expect.poll(() => early.length).toBe(1);
  expect(early[0]).toMatch(/^ace-media is not available/);
  // After the failure a tab has no source to open; a long-lived producer is told at once.
  expect(media?.add(producer([]))).toBeUndefined();
  const late: string[] = [];
  media?.attach(producer(late));
  expect(late).toEqual(early);
});

it("a client's media connection starts ace-media whatever media.delivery says: it is the only delivery", async () => {
  const read: string[] = [];
  // A home whose Beta switch was left off: the setting says the daemon delivers.
  const settings = {
    get: async (key: string) => {
      read.push(key);
      return key === "media.delivery" ? { value: "legacy" } : undefined;
    },
    onChange: () => () => {},
  };
  const { media, dir } = await daemonWith(
    `if [ "$1" = "--version" ]; then echo "ace-media 0.0.0"; else touch "$(dirname "$0")/ran"; sleep 5; fi`,
    settings,
  );
  await expect.poll(() => media?.delivery()).toBeDefined();
  void media?.delivery()?.connect(phoneOwner);
  await expect.poll(() => existsSync(join(dir, "ran")), { timeout: 5_000 }).toBe(true);
  expect(read).not.toContain("media.delivery");
});
