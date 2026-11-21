import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { IngestAddress, IngestProducer } from "@ace/media/ingest-sources";
import type { DeviceMedia } from "./media-paths.ts";
import { fixture, until, type Cleanup } from "./testing/fake-scrcpy.ts";

/*
 * An Android capture holds an ace-media source (its demand keeps ace-media running) and, while
 * moving to an ingest, a writer waiting for the device's next keyframe. Neither may outlive the
 * capture: not when scrcpy's startup fails, and not when it stops mid-move.
 */

const cleanup: Cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** ace-media at the edge: records each source and whether it was closed; points on request. */
function recording() {
  const sources: { producer: IngestProducer; closed: boolean }[] = [];
  const media: DeviceMedia = {
    attach: (producer) => {
      const entry = { producer, closed: false };
      sources.push(entry);
      return {
        streaming: () => false,
        reconnect: () => {},
        codecs: () => {},
        encodes: () => {},
        key: () => {},
        picture: () => false,
        close: () => {
          entry.closed = true;
        },
      };
    },
  };
  return { media, sources };
}

it("an emulator whose scrcpy startup fails leaves no ace-media source open behind it", async () => {
  const ace = recording();
  await expect(fixture(cleanup, { resetAtControl: true, media: ace.media })).rejects.toMatchObject({
    code: "command_failed",
  });
  expect(ace.sources.length).toBeGreaterThan(0);
  expect(ace.sources.every((source) => source.closed)).toBe(true);
});

it("a capture stopped while its move to ace-media waits for the device's keyframe settles that move", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-scrcpy-move-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, "ingest.sock");
  const server = createServer((connection) => void connection.resume());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const ace = recording();
  const { capture, frames } = await fixture(cleanup, { media: ace.media });
  // The device's opening units went by before ace-media had the source; it sends no more.
  await until(() => (ace.sources.length ? true : undefined));
  const producer = ace.sources[0]?.producer;
  const address: IngestAddress = {
    url: "",
    socket,
    token: new Uint8Array(32),
    epoch: 0,
    path: "p1",
  };
  let settled = false;
  const move = producer?.point(address).then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  await capture.stop();
  await until(() => (settled ? true : undefined));
  await move;
  expect(ace.sources.every((source) => source.closed)).toBe(true);
  expect(frames.every((frame) => frame.header.codec !== "jpeg")).toBe(true);
});
