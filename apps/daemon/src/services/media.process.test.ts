import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { IngestProducer } from "@ace/media/ingest-sources";
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

async function daemonWith(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-media-service-"));
  const binary = join(dir, "ace-media");
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  const before = process.env.ACE_MEDIA_PATH;
  process.env.ACE_MEDIA_PATH = binary;
  const resources = new Resources();
  const logged: string[] = [];
  const context = {
    services: {},
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
  return { media: startMedia(context), logged };
}

function producer(stops: string[]): IngestProducer {
  return {
    source: "tab-1",
    kind: "tab",
    origin: { kind: "tab" },
    epoch: () => 0,
    consumers: { deliver: () => {}, record: () => {}, still: () => {} },
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
