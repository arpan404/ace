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

/** A long page that scrolls itself every frame while `window.scrolling` is true. */
async function scrollingSite() {
  const lines = Array.from(
    { length: 400 },
    (_, index) => `<p>Line ${index}: the quick brown fox jumps over the lazy dog.</p>`,
  ).join("");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Scrolling</title><body>${lines}<script>
      window.scrolling = true;
      (function scroll() {
        if (!window.scrolling) return;
        window.scrollBy(0, 3);
        if (window.scrollY + innerHeight >= document.body.scrollHeight) window.scrollTo(0, 0);
        requestAnimationFrame(scroll);
      })();
    </script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/scroll`;
}

/** A phone viewer over a binary connection that asks for H.264 and acks what it receives. */
function phoneViewer(service: BrowserService) {
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
        viewport: { width: 640, height: 400, devicePixelRatio: 2 },
        video: { codecs: ["avc1.42E033"] },
      }),
  };
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

describe.skipIf(!executable || process.platform === "win32")("Use my Chrome live video", () => {
  test("a remote viewer of an agent's tab in the person's Chrome plays H.264 video, and ace's encoder Chrome runs only while someone watches", async () => {
    const browser = await connectedBrowser(executable ?? "", cleanups);
    const page = await scrollingSite();
    // ace's own browser service, as the daemon runs it: it owns the encoder-only Chrome.
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
    await service.execute("thread", { action: "resize", width: 640, height: 400 });
    await service.execute("thread", { action: "navigate", url: page });
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
});
