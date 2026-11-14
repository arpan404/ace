import { afterEach, expect, it } from "vitest";
import type { BrowserService } from "./index.ts";
import { connectBrowser } from "./index.ts";
import { idleThread, settle, type RestingTabs } from "./idle-test-support.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A person's video viewer of the thread: the chunks it was sent, in order. */
async function watch(service: BrowserService) {
  const chunks: BrowserVideoChunk[] = [];
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind === "browser.video") chunks.push(message.chunk);
      }
      return true;
    },
  });
  let closed = false;
  const leave = () => {
    if (closed) return;
    closed = true;
    bridge.close();
  };
  cleanups.push(async () => leave());
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 640, height: 400, devicePixelRatio: 1 },
    video: { codecs: ["vp8"] },
  });
  const ack = (sequence: number) =>
    bridge.handle({
      type: "browser.ack",
      threadId: "thread",
      requestId: `ack-${sequence}`,
      sequence,
      video: true,
    });
  return { chunks, ack, leave };
}

/** The tab capture the live video opened `index`th, once it was told what to encode. */
async function capture(backend: RestingTabs, index: number) {
  await expect
    .poll(() => backend.captures[index]?.encodes.length ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(0);
  const opened = backend.captures[index];
  const encode = opened?.encodes[0]?.key;
  if (!opened || !encode) throw new Error("No capture");
  /** One encoded picture, marked so the test can tell which it is. */
  const send = (marker: number, key: boolean) =>
    opened.events.chunk({
      encode,
      key,
      codec: "vp8",
      codedWidth: 640,
      codedHeight: 400,
      bytes: new Uint8Array([marker]),
    });
  return { opened, send };
}

it("a running video stops while its tab is restored, sends nothing while the restore fails, and starts again at a keyframe", async () => {
  const t = await idleThread();
  // The tab starts to rest just as a person comes to watch it.
  const hidden = t.backend.hold("hide a");
  t.lookAfter(defaultTabLifecycle.restAfterMs);
  await settle();
  const viewer = await watch(t.service);
  const before = await capture(t.backend, 0);
  before.send(1, true);
  before.send(2, false);
  await expect.poll(() => viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2]);

  t.backend.fail("show a");
  hidden();
  await expect.poll(() => t.service.state("thread").video?.status).toBe("retrying");
  // The capture of the page being hidden ended; what it still sends, and acks, deliver nothing.
  expect(before.opened.closed).toBe(true);
  before.send(3, true);
  await viewer.ack(viewer.chunks.at(-1)?.sequence ?? 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2]);
  // Nor does any capture start while the page is still hidden.
  expect(t.backend.captures).toHaveLength(1);

  t.navigationClock.advance(1_000);
  const after = await capture(t.backend, 1);
  expect(t.backend.steps("a")).toEqual(["hide a", "show a"]);
  // A delta cannot be the first picture: the viewer starts at the new capture's keyframe.
  after.send(4, false);
  after.send(5, true);
  await expect.poll(() => viewer.chunks.map((chunk) => chunk.bytes[0])).toEqual([1, 2, 5]);
  expect(viewer.chunks.at(-1)?.key).toBe(true);
  expect(t.service.state("thread").video).toBeUndefined();
});

it("a viewer coming back to a frozen tab whose window will not show yet sees retrying, not a paused browser", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  t.backend.fail("show a");
  await watch(t.service);
  await expect
    .poll(() => t.service.state("thread").video)
    .toMatchObject({ status: "retrying", attempts: 1 });
  expect(t.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  expect(t.lifecycle("a")).toBe("frozen");

  t.navigationClock.advance(1_000);
  await expect.poll(() => t.backend.steps("a")).toEqual(["hide a", "freeze a", "show a", "thaw a"]);
  await expect.poll(() => t.service.state("thread").video).toBeUndefined();
  expect(t.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  expect(t.lifecycle("a")).toBe("live");
  // The page is captured afresh once it runs again.
  await capture(t.backend, 0);
});

it("a wake that fails after the viewer left neither reports retrying nor tries again", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  const showing = t.backend.hold("show a");
  t.backend.fail("show a");
  const viewer = await watch(t.service);
  await settle();
  // The viewer leaves while the window is still being shown; the show then fails.
  viewer.leave();
  await settle();
  showing();
  await settle();
  expect(t.service.state("thread").video).toBeUndefined();
  t.navigationClock.advance(60_000);
  await settle();
  expect(t.backend.steps("a")).toEqual(["hide a"]);
});
