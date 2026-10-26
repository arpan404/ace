import { describe, expect, it } from "vitest";
import { connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler, type StreamMessage } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { videoWindow } from "./video-fanout.ts";
import { executablePath, fixture } from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A phone-sized viewer over a binary connection that asks for video. */
function videoViewer(f: Fixture, connectionId = "phone", codecs = ["avc1.42E033", "vp8"]) {
  const streamed: StreamMessage[] = [];
  /** The type of every JSON message the connection sent. */
  const sent: string[] = [];
  const assembler = new StreamAssembler();
  const waiters = new Set<() => void>();
  const bridge = connectBrowser(f.service, {
    connectionId,
    authorize: () => true,
    send: (message) => {
      sent.push(message.type);
      return true;
    },
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message) streamed.push(message);
      }
      for (const waiter of waiters) waiter();
      return true;
    },
  });
  const video = () =>
    streamed.flatMap((message) => (message.kind === "browser.video" ? [message.chunk] : []));
  const until = (done: () => boolean, timeoutMs = 20_000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!done()) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Timed out waiting for the stream"));
      }, timeoutMs);
      waiters.add(check);
      check();
    });
  const ack = (sequence: number, keyframe = false) =>
    bridge.handle({
      type: "browser.ack",
      threadId: "thread",
      requestId: `ack-${sequence}`,
      sequence,
      video: true,
      ...(keyframe ? { keyframe: true } : {}),
    });
  return {
    bridge,
    streamed,
    sent,
    video,
    until,
    ack,
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        binaryFrames: true,
        viewport: { width: 640, height: 400, devicePixelRatio: 2 },
        video: { codecs },
      }),
    /** The viewer's screen changed: it now shows the pane at `devicePixelRatio`. */
    rescale: (devicePixelRatio: number) =>
      bridge.handle({
        type: "browser.capture",
        threadId: "thread",
        requestId: `capture-${devicePixelRatio}`,
        viewport: { width: 640, height: 400, devicePixelRatio },
      }),
  };
}

/** Decodes chunks with WebCodecs in the page itself: how many pictures come out, and their size. */
async function decode(f: Fixture, chunks: readonly BrowserVideoChunk[]) {
  const first = chunks[0];
  if (!first?.key) throw new Error("Decoding must start at a keyframe");
  const input = chunks.map((chunk) => ({
    key: chunk.key,
    data: Buffer.from(chunk.bytes).toString("base64"),
    sequence: chunk.sequence,
  }));
  const config = {
    codec: first.codec,
    codedWidth: first.codedWidth,
    codedHeight: first.codedHeight,
    ...(first.description
      ? { description: Buffer.from(first.description).toString("base64") }
      : {}),
  };
  const result = await f.evaluate(`(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const config = ${JSON.stringify(config)};
    const pictures = [];
    const errors = [];
    const decoder = new VideoDecoder({
      // The visible picture: a decoder's coded size may include padding rows (Linux, software).
      output: (frame) => { pictures.push([frame.displayWidth, frame.displayHeight]); frame.close(); },
      error: (error) => errors.push(String(error)),
    });
    decoder.configure({ ...config, ...(config.description ? { description: bytes(config.description) } : {}) });
    for (const chunk of ${JSON.stringify(input)})
      decoder.decode(new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp: chunk.sequence, data: bytes(chunk.data) }));
    await decoder.flush().catch((error) => errors.push(String(error)));
    return JSON.stringify({ pictures, errors });
  })()`);
  return JSON.parse(String(result)) as { pictures: [number, number][]; errors: string[] };
}

const animate =
  "window.animating=true; window.counter=0; (function animate(){ if(!window.animating)return; document.body.style.background=`rgb(${++window.counter%255},40,90)`; document.getElementById('result').textContent=String(window.counter); requestAnimationFrame(animate)})()";

describe.skipIf(!executablePath)("live video from ace's Chrome", () => {
  it("a viewer that asks for video starts at a keyframe sized for its screen, plays decodable video and never gets JPEG", async () => {
    const f = await fixture();
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
    const viewer = videoViewer(f);
    await viewer.subscribe();
    await f.evaluate(animate);
    await viewer.until(() => viewer.video().length > 0);
    // The first thing the viewer gets is a keyframe: nothing before it, no JPEG stand-in.
    const key = viewer.video()[0];
    if (!key) throw new Error("No video");
    expect(key.key).toBe(true);
    expect(viewer.streamed[0]?.kind).toBe("browser.video");
    expect(key).toMatchObject({ width: 640, height: 400, codec: "avc1.42E033" });
    // The pane is 640 × 400 CSS pixels at DPR 2: the picture is 1280 × 800 device pixels.
    expect([key.codedWidth, key.codedHeight]).toEqual([1280, 800]);
    // Acked as shown, deltas keep coming.
    for (let index = 0; index < 6; index++) {
      const shown = viewer.video().at(-1);
      if (shown) await viewer.ack(shown.sequence);
      const count = viewer.video().length;
      await viewer.until(() => viewer.video().length > count);
    }
    const played = viewer.video();
    expect(played.filter((chunk) => !chunk.key).length).toBeGreaterThan(0);
    const decoded = await decode(f, played);
    expect(decoded.errors).toEqual([]);
    expect(decoded.pictures.length).toBe(played.length);
    expect(decoded.pictures[0]).toEqual([1280, 800]);
    // Live views are video only: no JPEG frame on either channel, ever.
    expect(viewer.streamed.filter((message) => message.kind === "browser.frame")).toEqual([]);
    expect(viewer.sent.filter((type) => type === "browser.frame")).toEqual([]);
    await f.evaluate("window.animating=false");
    viewer.bridge.close();
  }, 90_000);

  it("a viewer whose screen changes scale gets a keyframe sized for the new screen", async () => {
    const f = await fixture();
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
    const viewer = videoViewer(f);
    await viewer.subscribe();
    await f.evaluate(animate);
    await viewer.until(() => viewer.video().some((chunk) => chunk.key));
    expect(viewer.video().find((chunk) => chunk.key)?.codedWidth).toBe(1280);
    // Moved to a DPR 1 screen: the picture is only what it shows there.
    const before = viewer.video().length;
    await viewer.rescale(1);
    const resized = () =>
      viewer
        .video()
        .slice(before)
        .find((chunk) => chunk.key);
    await viewer.until(() => {
      const shown = viewer.video().at(-1);
      if (shown) void viewer.ack(shown.sequence);
      return resized()?.codedWidth === 640;
    });
    // Input coordinates still refer to the page's CSS size, not the picture's pixels.
    expect(resized()).toMatchObject({ width: 640, height: 400, codedWidth: 640, codedHeight: 400 });
    await f.evaluate("window.animating=false");
    viewer.bridge.close();
  }, 90_000);

  it("a video viewer keeps playing after the browser closes and reopens", async () => {
    const f = await fixture();
    await f.navigate();
    const viewer = videoViewer(f);
    await viewer.subscribe();
    await f.evaluate(animate);
    await viewer.until(() => viewer.video().some((chunk) => chunk.key));
    await f.service.closeThread("thread");
    const before = viewer.video().length;
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    await f.evaluate(animate);
    // The same viewer, without subscribing again, starts over at a keyframe of the new page.
    await viewer.until(() => {
      const shown = viewer.video().at(-1);
      if (shown) void viewer.ack(shown.sequence);
      return viewer
        .video()
        .slice(before)
        .some((chunk) => chunk.key);
    });
    await f.evaluate("window.animating=false");
    viewer.bridge.close();
  }, 90_000);

  it("a viewer on a connection without binary messages follows the browser's state but gets no pictures", async () => {
    const f = await fixture();
    await f.navigate();
    const sent: string[] = [];
    const bridge = connectBrowser(f.service, {
      connectionId: "plain",
      authorize: () => true,
      send: (message) => {
        sent.push(message.type);
        return true;
      },
    });
    // It asks for video, but video travels only as binary messages.
    await bridge.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: "subscribe",
      binaryFrames: true,
      viewport: { width: 640, height: 400, devicePixelRatio: 1 },
      video: { codecs: ["avc1.42E033", "vp8"] },
    });
    await f.evaluate(animate);
    await f.service.execute("thread", { action: "navigate", url: `${f.url}/?again` });
    expect(sent).toContain("browser.state");
    // No JPEG stand-in on the JSON channel either.
    expect(sent).not.toContain("browser.frame");
    await f.evaluate("window.animating=false");
    bridge.close();
  }, 90_000);

  it("a viewer whose decoder lost its place gets a fresh keyframe", async () => {
    const f = await fixture();
    await f.navigate();
    const viewer = videoViewer(f);
    await viewer.subscribe();
    await f.evaluate(animate);
    await viewer.until(() => viewer.video().some((chunk) => chunk.key));
    const keys = () => viewer.video().filter((chunk) => chunk.key).length;
    const before = keys();
    const latest = viewer.video().at(-1);
    if (!latest) throw new Error("No video");
    await viewer.ack(latest.sequence, true);
    // Keep acking so the window stays open, until the asked-for keyframe arrives.
    await viewer.until(() => {
      const shown = viewer.video().at(-1);
      if (shown) void viewer.ack(shown.sequence);
      return keys() > before;
    }, 10_000);
    expect(keys()).toBeGreaterThan(before);
    await f.evaluate("window.animating=false");
    viewer.bridge.close();
  }, 90_000);

  it("a viewer that never acks gets no more than its window, and the others keep playing", async () => {
    const f = await fixture();
    await f.navigate();
    const stalled = videoViewer(f, "stalled");
    const keeping = videoViewer(f, "keeping-up");
    await stalled.subscribe();
    await keeping.subscribe();
    await f.evaluate(animate);
    await stalled.until(() => stalled.video().some((chunk) => chunk.key));
    // Well past a full window (a second at 60 fps); one viewer acks each chunk, one none.
    await keeping.until(() => {
      const shown = keeping.video().at(-1);
      if (shown) void keeping.ack(shown.sequence);
      return keeping.video().length >= 2 * videoWindow.frames;
    });
    expect(stalled.video().length).toBeLessThanOrEqual(videoWindow.frames);
    await f.evaluate("window.animating=false");
    stalled.bridge.close();
    keeping.bridge.close();
  }, 90_000);
});
