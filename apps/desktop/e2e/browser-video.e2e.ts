import { afterEach, expect, it } from "vitest";
import { startVideoSession, threadId, watchVideo } from "./fixtures/video-session.ts";

/**
 * A remote viewer of a desktop view gets H.264 from the app's own encoder (ADR 0088, embedded
 * backend), in real Electron: the app's views, backend, connection and encoder
 * (`fixtures/video-main.ts`) register with a daemon's `BrowserService` over a real socket, and
 * a viewer of that service subscribes for video. The page animates every frame and nothing
 * shows it in the app. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const animated = `<!doctype html><body style="margin:0"><canvas id=c></canvas><script>
const canvas = document.getElementById("c");
canvas.width = innerWidth; canvas.height = innerHeight;
const g = canvas.getContext("2d"); let n = 0;
(function draw() {
  n++;
  g.fillStyle = "hsl(" + (n * 3 % 360) + ",60%,50%)"; g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000"; g.font = "64px sans-serif"; g.fillText("frame " + n, 40, 120);
  requestAnimationFrame(draw);
})();</script>`;

/** NAL unit types in one AVC-format chunk (4-byte lengths, as `avc: { format: "avc" }`). */
function nalTypes(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: number[] = [];
  for (let offset = 0; offset + 4 < bytes.length;) {
    const length = view.getUint32(offset);
    types.push((bytes[offset + 4] ?? 0) & 0x1f);
    offset += 4 + length;
  }
  return types;
}

it.runIf(enabled)(
  "a remote viewer of an unseen desktop view gets decodable H.264 at the page's frame rate",
  async () => {
    const { service, origin } = await startVideoSession(cleanups, { "/": animated });
    await service.execute(threadId, { action: "navigate", url: `${origin}/` });
    await service.execute(threadId, { action: "resize", width: 1280, height: 800 });

    const tally = { chunks: 0, keyframes: 0, bytes: 0, counting: false, frames: 0 };
    const keys: { description: Uint8Array | undefined; nals: number[] }[] = [];
    const viewer = await watchVideo(cleanups, service, {
      viewport: { width: 1280, height: 800 },
      codecs: ["avc1.42E033"],
      onChunk(chunk) {
        if (chunk.key) keys.push({ description: chunk.description, nals: nalTypes(chunk.bytes) });
        if (!tally.counting) return;
        tally.chunks++;
        tally.bytes += chunk.bytes.length;
        if (chunk.key) tally.keyframes++;
      },
    });
    await expect.poll(() => keys.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const seconds = 5;
    const framesBefore = viewer.frames();
    tally.counting = true;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    tally.counting = false;
    tally.frames = viewer.frames() - framesBefore;
    const fps = tally.chunks / seconds;
    console.log(
      JSON.stringify({
        videoFramesPerSecond: fps,
        videoMegabitsPerSecond: Number(((tally.bytes * 8) / seconds / 1e6).toFixed(2)),
        keyframes: tally.keyframes,
        jpegFramesWhileVideo: tally.frames,
      }),
    );
    const [first] = keys;
    // The decoder is configured from the keyframe alone: an avcC record, and an IDR picture.
    expect(first?.description?.[0]).toBe(1);
    expect(first?.nals).toContain(5);
    // The page draws every frame, unseen: the capture keeps up with the encode's frame rate
    // (the policy's top tier; measured equal to it, 30 and 60 fps).
    expect(fps).toBeGreaterThanOrEqual(25);
    expect(tally.frames).toBe(0);
  },
);
