import { createServer } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { connectBrowser } from "./index.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";
import type { BrowserTabRecord } from "./tab-store.ts";
import { executablePath, fixture } from "./test-support.ts";

/**
 * ace's Chrome with a lifecycle timer the test fires at a time it sets. `idleFor` lets time pass
 * with the thread untouched, fires the timer and waits until its work is done (it arms the next).
 */
async function idleBrowser(options: Parameters<typeof fixture>[0] = {}) {
  const clock = { now: 0 };
  const ticks: (() => void)[] = [];
  const f = await fixture({
    now: () => clock.now,
    tabLifecycle: {
      policy: defaultTabLifecycle,
      every: 60_000,
      set: (_delay, work) => {
        ticks.push(work);
        return () => {};
      },
    },
    ...options,
  });
  const idleFor = async (milliseconds: number) => {
    clock.now += milliseconds;
    const tick = ticks.shift();
    if (!tick) throw new Error("No lifecycle timer armed");
    tick();
    await expect.poll(() => ticks.length).toBe(1);
  };
  const shown = () => {
    const state = f.service.state("thread");
    return state.tabs?.find((tab) => tab.tabId === state.activeTabId);
  };
  return { f, idleFor, shown };
}

/** Records the page's visibility changes and counts the frames it draws. */
const watchDrawing = `window.seen = []; window.drawn = 0;
  document.addEventListener("visibilitychange", () => seen.push(document.visibilityState));
  (function draw() { drawn++; requestAnimationFrame(draw); })();`;

/** Red now; once the page is hidden it turns green, so only a picture taken since is green. */
const paintOnceHidden = `document.body.style.background = "rgb(255, 0, 0)";
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setTimeout(() => { document.body.style.background = "rgb(0, 160, 0)"; }, 50);
  });`;
/** Real time for a hidden page's own timers to run, without touching the page. */
const letPageRun = () => new Promise((resolve) => setTimeout(resolve, 500));
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A picture's size and its middle pixel, decoded by the page itself. */
async function look(f: Fixture, bytes: Uint8Array): Promise<number[]> {
  const data = JSON.stringify(Buffer.from(bytes).toString("base64"));
  return (await f.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${data}), (c) => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data;
    return [image.width, image.height, r, g, b];
  })()`)) as number[];
}
/** A keyframe's middle pixel, decoded with WebCodecs in the page itself. */
async function decodedMiddle(f: Fixture, chunk: BrowserVideoChunk): Promise<number[]> {
  const config = {
    codec: chunk.codec,
    codedWidth: chunk.codedWidth,
    codedHeight: chunk.codedHeight,
    ...(chunk.description
      ? { description: Buffer.from(chunk.description).toString("base64") }
      : {}),
  };
  const data = JSON.stringify(Buffer.from(chunk.bytes).toString("base64"));
  return (await f.evaluate(`(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const config = ${JSON.stringify(config)};
    const frames = [];
    const decoder = new VideoDecoder({ output: (frame) => frames.push(frame), error: () => {} });
    decoder.configure({ ...config, ...(config.description ? { description: bytes(config.description) } : {}) });
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: bytes(${data}) }));
    await decoder.flush();
    const frame = frames[0];
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const context = canvas.getContext("2d");
    context.drawImage(frame, 0, 0);
    frame.close();
    return [...context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)];
  })()`)) as number[];
}

describe.skipIf(!executablePath)("an unwatched browser in ace's Chrome", () => {
  it("the shown tab nobody watches stops drawing once idle, and draws again before an agent's next command", async () => {
    const { f, idleFor } = await idleBrowser();
    await f.navigate();
    await f.evaluate(watchDrawing);

    await idleFor(defaultTabLifecycle.restAfterMs);
    const before = Number(await f.evaluate("drawn"));
    // Asleep for a while: the page is hidden, so it draws no frames.
    await idleFor(defaultTabLifecycle.restAfterMs);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const [seen, visibility, drawn] = (await f.evaluate(
      "[seen.slice(), document.visibilityState, drawn]",
    )) as [string[], string, number];
    // Hidden while idle, shown again for the command, as a background tab is.
    expect(seen).toEqual(["hidden", "visible", "hidden", "visible"]);
    expect(visibility).toBe("visible");
    expect(drawn - before).toBeLessThan(10);
    // Its page kept its state and keeps drawing now that it is shown.
    await expect.poll(async () => Number(await f.evaluate("drawn"))).toBeGreaterThan(drawn + 5);
    expect(await f.evaluate("document.hasFocus()")).toBe(true);
  }, 60_000);

  it("a screenshot taken as the first command after a rest shows the page as it is now, at full size", async () => {
    const { f, idleFor } = await idleBrowser();
    await f.navigate();
    await f.evaluate(paintOnceHidden);
    const [width, height] = await look(f, await f.service.screenshot("thread"));
    await idleFor(defaultTabLifecycle.restAfterMs);
    // The page turns green while hidden and draws nothing since; then it freezes.
    await letPageRun();
    await idleFor(defaultTabLifecycle.freezeAfterMs);
    // The screenshot is the first thing to touch the page again.
    const [afterWidth, afterHeight, r, g, b] = await look(f, await f.service.screenshot("thread"));
    expect([afterWidth, afterHeight]).toEqual([width, height]);
    expect([r, g, b].map((value) => Math.round((value ?? 0) / 32))).toEqual([0, 5, 0]);
  }, 60_000);

  it("a viewer who starts watching a rested tab first sees the page as it is now, at full size", async () => {
    const { f, idleFor } = await idleBrowser();
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
    await f.evaluate(paintOnceHidden);
    await idleFor(defaultTabLifecycle.restAfterMs);
    await letPageRun();

    const chunks: BrowserVideoChunk[] = [];
    const assembler = new StreamAssembler();
    const bridge = connectBrowser(f.service, {
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
    onTestFinished(() => bridge.close());
    await bridge.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: "subscribe",
      binaryFrames: true,
      viewport: { width: 640, height: 400, devicePixelRatio: 2 },
      video: { codecs: ["avc1.42E033", "vp8"] },
    });
    await expect.poll(() => chunks.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = chunks[0];
    if (!first) throw new Error("No video");
    // A keyframe at the pane's full size, not a minimized window's.
    expect(first).toMatchObject({ key: true, width: 640, height: 400 });
    expect([first.codedWidth, first.codedHeight]).toEqual([1280, 800]);
    // Its picture is the page now (green), not the red it showed before it rested.
    const [r, g, b] = await decodedMiddle(f, first);
    expect([r, g, b].map((value) => Math.round((value ?? 0) / 32))).toEqual([0, 5, 0]);
  }, 60_000);

  it("the shown tab nobody watches freezes when idle, and runs again for the agent", async () => {
    const { f, idleFor, shown } = await idleBrowser();
    await f.navigate();
    await f.evaluate("window.marker = 'kept'");

    await idleFor(defaultTabLifecycle.freezeAfterMs);
    expect(shown()?.lifecycle).toBe("frozen");

    expect(await f.evaluate("window.marker")).toBe("kept");
    expect(shown()?.lifecycle ?? "live").toBe("live");
  }, 60_000);

  it("a shown tab a person watches never rests or freezes, and a frozen one runs again once someone watches", async () => {
    const { f, idleFor, shown } = await idleBrowser();
    await f.navigate();
    await f.evaluate(watchDrawing);
    await idleFor(defaultTabLifecycle.freezeAfterMs);
    expect(shown()?.lifecycle).toBe("frozen");

    const bridge = connectBrowser(f.service, {
      connectionId: "viewer",
      authorize: () => true,
      send: () => true,
      sendStream: () => true,
    });
    await bridge.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: "subscribe",
      binaryFrames: true,
      viewport: { width: 640, height: 400, devicePixelRatio: 1 },
      video: { codecs: ["vp8"] },
    });
    await expect.poll(() => shown()?.lifecycle ?? "live").toBe("live");

    // Watched for longer than any idle limit: it stays shown and running.
    await idleFor(defaultTabLifecycle.freezeAfterMs);
    expect(shown()?.lifecycle ?? "live").toBe("live");
    const seen = (await f.evaluate("seen.slice(-1)")) as string[];
    expect(seen).toEqual(["visible"]);
    bridge.close();
  }, 60_000);

  it("a thread's tabs come back after a restart even when one page's server is gone", async () => {
    // A port that refuses connections: a dev server that has stopped.
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
    const address = gone.address();
    if (!address || typeof address === "string") throw new Error("No address");
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const deadUrl = `http://127.0.0.1:${address.port}/`;

    const saved: BrowserTabRecord[] = [];
    const store = {
      load: () => saved,
      save: () => {},
      clear: () => {},
    };
    // The fixture opens its thread with what the store holds: the site's page and the dead one.
    const site = await fixture();
    const liveUrl = `${site.url}/controls`;
    saved.push(
      { tabId: "tab-live", position: 0, url: liveUrl, title: "Controls", lastActiveAt: 0 },
      { tabId: "tab-dead", position: 1, url: deadUrl, title: "Dev", lastActiveAt: 0 },
    );
    const errors: unknown[] = [];
    const f = await fixture({ tabStore: store, onError: (error) => errors.push(error) });

    const state = f.service.state("thread");
    expect(state).toMatchObject({ closed: false });
    expect(state.tabs?.map((tab) => [tab.tabId, tab.url])).toEqual([
      ["tab-live", liveUrl],
      ["tab-dead", deadUrl],
    ]);
    expect(
      await f.execute({ action: "evaluate", tabId: "tab-live", expression: "document.title" }),
    ).toBe("Controls");
    expect(errors).toEqual([]);
  }, 60_000);
});
