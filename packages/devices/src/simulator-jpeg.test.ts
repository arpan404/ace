import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";
import { recordingImages } from "./recording-feed.ts";
import { SimulatorJpeg } from "./simulator-jpeg.ts";
import { deviceImageStream, deviceStillStream } from "./stream-control.ts";

/** A screen painted one flat colour, as serve-sim's MJPEG would carry it. */
const screen = (red: number) =>
  sharp({ create: { width: 201, height: 437, channels: 3, background: { r: red, g: 0, b: 0 } } })
    .jpeg()
    .toBuffer();
const part = (image: Buffer) =>
  Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`),
    image,
    Buffer.from("\r\n"),
  ]);
const red = async (image: Buffer) => (await sharp(image).raw().toBuffer())[0] ?? 0;

/**
 * serve-sim's MJPEG route, as measured on a real Simulator: each new stream starts with the
 * current screen, and every open stream gets each change.
 */
async function fakeServeSim() {
  let current = await screen(0);
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let requests = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    requests++;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        open.add(controller);
        controller.enqueue(new Uint8Array(part(current)));
      },
      cancel() {
        if (stream) open.delete(stream);
      },
    });
    // Like fetch, aborting the request errors its body.
    init?.signal?.addEventListener("abort", () => {
      if (!stream || !open.delete(stream)) return;
      stream.error(new DOMException("aborted", "AbortError"));
    });
    return new Response(body, {
      headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
    });
  };
  return {
    fetch: fetcher,
    open: () => open.size,
    requests: () => requests,
    paint(image: Buffer) {
      current = image;
      for (const stream of open) stream.enqueue(new Uint8Array(part(image)));
    },
  };
}

async function capture() {
  const sim = await fakeServeSim();
  const published: Buffer[] = [];
  const jpeg = new SimulatorJpeg({
    url: new URL("http://127.0.0.1:1/helper/x/stream.mjpeg"),
    fps: 30,
    fetch: sim.fetch,
    now: () => performance.now(),
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    source() {},
    publish: (image) => published.push(image.bytes),
    failure(error) {
      throw error;
    },
  });
  onTestFinished(() => jpeg.stop());
  await jpeg.start();
  await expect.poll(() => published.length).toBe(1);
  return { sim, jpeg, published };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a Simulator nobody watches or records takes no pictures until an agent asks for a still", async () => {
  const { sim, jpeg, published } = await capture();
  await jpeg.configure(deviceStillStream);
  expect(sim.open()).toBe(0);
  const before = published.length;
  for (let index = 1; index <= 10; index++) sim.paint(await screen(index));
  await pause(50);
  expect(published.length).toBe(before);
});

it("a still shows the screen as it is when asked, not as it was before the last action", async () => {
  const { sim, jpeg, published } = await capture();
  await jpeg.configure(deviceStillStream);
  // The agent acts while the stream is closed: the screen turns red.
  sim.paint(await screen(255));
  await jpeg.replay();
  expect(await red(published.at(-1) ?? Buffer.alloc(0))).toBeGreaterThan(200);
  // The stream closes again once the still is made.
  expect(sim.open()).toBe(0);
  // A second action and still: again the new screen.
  sim.paint(await screen(40));
  await jpeg.replay();
  expect(await red(published.at(-1) ?? Buffer.alloc(0))).toBeLessThan(80);
  expect(sim.open()).toBe(0);
});

it("stills asked together share one picture from serve-sim", async () => {
  const { sim, jpeg } = await capture();
  await jpeg.configure(deviceStillStream);
  const requests = sim.requests();
  await Promise.all([jpeg.replay(), jpeg.replay(), jpeg.replay()]);
  expect(sim.requests() - requests).toBe(1);
  expect(sim.open()).toBe(0);
});

it("a recording keeps every change coming, and stills resume when it ends", async () => {
  const { sim, jpeg, published } = await capture();
  await jpeg.configure(deviceStillStream);
  await jpeg.configure({ ...deviceImageStream, ...recordingImages });
  expect(sim.open()).toBe(1);
  const before = published.length;
  for (let index = 1; index <= 5; index++) {
    sim.paint(await screen(index * 40));
    await pause(1000 / recordingImages.fps + 20);
  }
  await expect.poll(() => published.length - before).toBeGreaterThanOrEqual(5);
  expect(await red(published.at(-1) ?? Buffer.alloc(0))).toBeGreaterThan(180);
  await jpeg.configure(deviceStillStream);
  expect(sim.open()).toBe(0);
});
