import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BrowserService,
  UserChromeBackend,
  UserChromeTabsBackend,
  connectBrowser,
  detectChromium,
} from "@ace/browser";
import {
  decodeStreamMessage,
  StreamAssembler,
  type BrowserVideoChunk,
  type StreamMessage,
} from "@ace/browser/stream";
import { connectedBrowser, until } from "./my-chrome-test-support.ts";

/** Chrome for Testing (ace's pinned build) when the run names one; any Chromium otherwise. */
const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => {});
}, 60_000);

/** A long page that scrolls itself every frame. */
function scrollingPage() {
  const lines = Array.from(
    { length: 400 },
    (_, index) => `<p>Line ${index}: the quick brown fox jumps over the lazy dog.</p>`,
  ).join("");
  return `<!doctype html><title>Scrolling</title><body>${lines}<script>
    (function scroll() {
      window.scrollBy(0, 3);
      if (window.scrollY + innerHeight >= document.body.scrollHeight) window.scrollTo(0, 0);
      requestAnimationFrame(scroll);
    })();
  </script></body>`;
}

/**
 * A full-window canvas redrawn every frame: random pixels (whose JPEG no relay message holds)
 * while the body's `data-noise` is set, else a small square moving on white.
 */
function noisePage() {
  return `<!doctype html><title>Noise</title><body style="margin:0;overflow:hidden"><canvas></canvas><script>
    const canvas = document.querySelector("canvas");
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const context = canvas.getContext("2d");
    const noise = context.createImageData(canvas.width, canvas.height);
    const pixels = new Uint32Array(noise.data.buffer);
    let frame = 0;
    (function draw() {
      frame++;
      if (document.body.dataset.noise) {
        for (let index = 0; index < pixels.length; index++)
          pixels[index] = (Math.random() * 0xffffffff) | 0xff000000;
        context.putImageData(noise, 0, 0);
      } else {
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "black";
        context.fillRect((frame * 4) % canvas.width, 100, 40, 40);
      }
      requestAnimationFrame(draw);
    })();
  </script></body>`;
}

async function site() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(request.url === "/noise" ? noisePage() : scrollingPage());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * The person's Chrome with ace for Chrome and an agent's tab in it, and ace's own browser
 * service (which owns the encoder-only Chrome) wired to it as the daemon does. `encoders` are
 * the Chromes ace's service started.
 */
async function watchedUserChrome(chromeArgs: readonly string[] = []) {
  const browser = await connectedBrowser(executable ?? "", cleanups, chromeArgs);
  const encoders: ChildProcess[] = [];
  const ace = new BrowserService({
    dataDir: join(browser.root, "ace-data"),
    executablePath: executable ?? "",
    videoEncoderIdleMs: 500,
    chrome: {
      spawn: (command, args, options) => {
        const child = spawn(command, args, options);
        encoders.push(child);
        return child;
      },
    },
  });
  cleanups.push(() => ace.close());
  const service = new BrowserService({
    dataDir: join(browser.root, "user-threads"),
    headlessBackend: new UserChromeTabsBackend(
      new UserChromeBackend(browser.hub, process.platform, {
        videoEncoder: () => ace.videoEncoder(),
      }),
    ),
    backendPreference: () => "headless",
  });
  cleanups.push(() => service.close());
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  return { browser, encoders, service, origin: await site() };
}

/** A phone viewer over a binary connection that asks for H.264 and acks what it receives. */
function phoneViewer(
  service: BrowserService,
  viewport = { width: 640, height: 400, devicePixelRatio: 2 },
) {
  const video: BrowserVideoChunk[] = [];
  const kinds: StreamMessage["kind"][] = [];
  const assembler = new StreamAssembler();
  let acking = true;
  const bridge = connectBrowser(service, {
    connectionId: "phone",
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (!message) continue;
        kinds.push(message.kind);
        if (message.kind !== "browser.video") continue;
        video.push(message.chunk);
        // Acked after the send returns, as a client's ack arrives over the network.
        if (acking)
          setImmediate(
            () =>
              void bridge.handle({
                type: "browser.ack",
                threadId: "thread",
                requestId: `ack-${message.chunk.sequence}`,
                sequence: message.chunk.sequence,
                video: true,
              }),
          );
      }
      return true;
    },
  });
  return {
    video,
    kinds,
    bridge,
    stopAcking: () => {
      acking = false;
    },
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        binaryFrames: true,
        viewport,
        video: { codecs: ["avc1.42E033"] },
      }),
  };
}

describe.skipIf(!executable || process.platform === "win32")("Use my Chrome live video", () => {
  test("a remote viewer of an agent's tab in the person's Chrome plays H.264 video, and ace's encoder Chrome runs only while someone watches", async () => {
    const { browser, encoders, service, origin } = await watchedUserChrome();
    await service.execute("thread", { action: "resize", width: 640, height: 400 });
    await service.execute("thread", { action: "navigate", url: `${origin}/scroll` });
    // An agent working the person's tab with nobody watching starts no encoder.
    expect(encoders).toEqual([]);

    const viewer = phoneViewer(service);
    await viewer.subscribe();
    await until(() => viewer.video.length > 0, "the first video chunk");
    const [key] = viewer.video;
    expect(key).toMatchObject({ key: true, codec: "avc1.42E033", width: 640, height: 400 });
    // The viewer's screen is DPR 2, but the person's (headless) Chrome draws the tab at DPR 1:
    // the picture is capped at the pixels the tab renders.
    expect([key?.codedWidth, key?.codedHeight]).toEqual([640, 400]);
    expect(viewer.kinds.every((kind) => kind === "browser.video")).toBe(true);
    expect(encoders.filter(running)).toHaveLength(1);

    // The page keeps scrolling: chunks keep coming at the screencast's pace.
    const startCount = viewer.video.length;
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const fps = ((viewer.video.length - startCount) * 1000) / (Date.now() - startedAt);
    // 60 on an idle Apple M-series machine; the bound leaves room for a loaded one.
    expect(fps).toBeGreaterThan(20);

    // What the viewer got decodes from its first keyframe on.
    viewer.stopAcking();
    const played = viewer.video.slice(0, 60);
    const decoded = await browser.asPerson(`(async () => {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const chunks = ${JSON.stringify(
        played.map((chunk) => ({
          key: chunk.key,
          sequence: chunk.sequence,
          data: Buffer.from(chunk.bytes).toString("base64"),
        })),
      )};
      const pictures = [];
      const errors = [];
      const decoder = new VideoDecoder({
        output: (frame) => { pictures.push([frame.codedWidth, frame.codedHeight]); frame.close(); },
        error: (error) => errors.push(String(error)),
      });
      decoder.configure({
        codec: ${JSON.stringify(key?.codec)},
        codedWidth: ${key?.codedWidth},
        codedHeight: ${key?.codedHeight},
        description: bytes(${JSON.stringify(Buffer.from(key?.description ?? []).toString("base64"))}),
      });
      for (const chunk of chunks)
        decoder.decode(new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp: chunk.sequence, data: bytes(chunk.data) }));
      await decoder.flush().catch((error) => errors.push(String(error)));
      return JSON.stringify({ pictures, errors });
    })()`);
    const result = JSON.parse(String(decoded)) as { pictures: number[][]; errors: string[] };
    expect(result.errors).toEqual([]);
    expect(result.pictures).toHaveLength(played.length);
    expect(result.pictures[0]).toEqual([640, 400]);

    // The viewer leaves: the encoder Chrome stops once it has been idle for its timeout.
    viewer.bridge.close();
    await until(() => !encoders.some(running), "the encoder Chrome to stop");
  }, 120_000);

  test("pictures too large for the relay are skipped, and the video resumes once the page's pictures fit", async () => {
    // A screen and window large enough for a 1920 × 1080 tab.
    const { service, origin } = await watchedUserChrome([
      "--screen-info={0,0 2560x1600}",
      "--window-size=2100,1400",
    ]);
    await service.execute("thread", { action: "resize", width: 1920, height: 1080 });
    await service.execute("thread", { action: "navigate", url: `${origin}/noise` });
    const viewer = phoneViewer(service, { width: 1920, height: 1080, devicePixelRatio: 1 });
    await viewer.subscribe();
    await until(() => viewer.video.length > 10, "video of the calm page");
    // Two seconds of 1920 px noise: every screencast picture is over the relay's 1 MiB.
    await service.execute("thread", {
      action: "evaluate",
      expression: "document.body.dataset.noise = '1'",
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await service.execute("thread", {
      action: "evaluate",
      expression: "delete document.body.dataset.noise",
    });
    // Chrome did not stall waiting for acks of the pictures the relay could not carry.
    const before = viewer.video.length;
    await until(() => viewer.video.length > before + 30, "video after the noise");
  }, 120_000);
});
