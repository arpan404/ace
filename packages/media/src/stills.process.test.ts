/*
 * An agent's still against the real ace-media (`still.take.fresh`): right after an agent's
 * input, the still must show the screen after it, never the picture ace-media already held.
 * The unit tests fake ace-media's still cache; this one runs a JPEG source into the real binary
 * on its own ingest and asks it, so its cache, its fence and its answer are its own. Runs when
 * ACE_MEDIA_TEST_BINARY names a built ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { IngestProducer, IngestSource } from "./ingest-sources.ts";
import { IngestWriter, stillPictureFrame } from "./ingest-writer.ts";
import { MediaRuntime } from "./runtime.ts";
import { nodeMediaHost, systemMediaClock } from "./supervisor.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const before = readFileSync(new URL("../../screen/src/testing/phone-screen.jpg", import.meta.url));
const after = readFileSync(
  new URL(
    "../../../native/media/crates/media-codec/bench/data/still-1206x2622.jpg",
    import.meta.url,
  ),
);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A screencast tab streaming its JPEG pictures into the real ace-media. */
async function tab() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
  let next = 0;
  const media = new MediaRuntime({
    version: execFileSync(binary ?? "", ["--version"])
      .toString()
      .trim(),
    binary: binary ?? "",
    runtimeDir,
    dataDir: runtimeDir,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `t${++next}`,
    log: () => {},
  });
  let writer: IngestWriter | undefined;
  const producer: IngestProducer = {
    source: "tab",
    kind: "tab-pictures",
    origin: { kind: "tab-pictures" },
    epoch: () => 0,
    private: () => false,
    consumers: { deliver: () => {} },
    keyframe: () => {},
    point: (address) => {
      writer?.close();
      writer = address
        ? new IngestWriter({
            socket: address.socket,
            token: address.token,
            onClosed: () => {},
            onKeyframe: () => {},
          })
        : undefined;
      return Promise.resolve();
    },
  };
  const source: IngestSource = media.sources.add(producer);
  cleanups.push(() => {
    writer?.close();
    source.close();
    media.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  await until(() => writer !== undefined && source.streaming());
  const show = (jpeg: Buffer, width: number, height: number) => {
    const frame = stillPictureFrame(jpeg, { width, height }, 0);
    if (frame) writer?.write(frame);
  };
  /** An agent's still: ace-media's size of it, or "own" when the source's capture answered. */
  const still = (fresh: boolean) =>
    source.still?.(
      {
        maxWidth: 2000,
        maxHeight: 2000,
        maxPixels: 4_000_000,
        quality: 80,
        deadlineMs: 2_000,
        fresh,
      },
      () => Promise.resolve("own"),
      (made) => `${made.width}x${made.height}`,
    ) ?? Promise.resolve("own");
  return { show, still };
}

it.runIf(binary)(
  "an agent's still right after its input is the screen after it, never the picture ace-media held",
  async () => {
    const t = await tab();
    // The screen before the input, in ace-media's cache.
    t.show(before, 390, 844);
    let cached = "";
    await until(() => {
      void t.still(false).then((size) => (cached = size));
      return cached === "390x844";
    });
    // The input lands; the still is asked; the next picture is the screen after it.
    const taken = t.still(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    t.show(after, 1206, 2622);
    expect(await taken).toBe("920x2000");
    // With no picture after the request, the source's own capture answers, not the old one.
    expect(await t.still(true)).toBe("own");
  },
  60_000,
);
