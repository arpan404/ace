import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { BrowserService, connectBrowser } from "@ace/browser";
import { decodeStreamMessage, StreamAssembler } from "@ace/browser/stream";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";
import { credential, relayDaemon, token } from "../src/main/browser/relay-test-support.ts";

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
    const out = await mkdtemp(join(tmpdir(), "ace-e2e-video-build-"));
    const home = await mkdtemp(join(tmpdir(), "ace-e2e-video-home-"));
    cleanups.push(() => rm(out, { recursive: true, force: true }));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const shared = {
      bundle: true,
      external: ["electron"],
      logLevel: "warning" as const,
    };
    await build({
      ...shared,
      entryPoints: [join(desktop, "e2e/fixtures/video-main.ts")],
      outfile: join(out, "main.mjs"),
      format: "esm",
      platform: "node",
      target: "node24",
      banner: {
        js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
      },
    });
    await build({
      ...shared,
      entryPoints: [join(desktop, "src/preload/video-encoder.ts")],
      outfile: join(out, "video-encoder-preload.cjs"),
      format: "cjs",
      platform: "browser",
      target: "chrome140",
    });
    await writeFile(join(home, "browser-desktop.json"), JSON.stringify(credential));

    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(animated);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test HTTP port");

    // The daemon's browser service; with no Chrome to fall back on, only the desktop serves it.
    const service = new BrowserService({ dataDir: home, executablePath: "/unavailable/headless" });
    cleanups.push(() => service.close());
    const daemon = await relayDaemon(cleanups, {
      register: (_id, transport) => service.registerEmbedded(transport),
    });

    const userData = await mkdtemp(join(tmpdir(), "ace-e2e-video-user-"));
    cleanups.push(() => rm(userData, { recursive: true, force: true }));
    const app: ElectronApplication = await electron.launch({
      executablePath: await electronBinary(),
      args: [join(out, "main.mjs")],
      env: {
        ...appEnvironment(process.env),
        ACE_E2E_USER_DATA: userData,
        ACE_E2E_HOME: home,
        ACE_E2E_DAEMON_URL: daemon.url,
        ACE_E2E_TOKEN: token,
        ACE_E2E_VIDEO_PRELOAD: join(out, "video-encoder-preload.cjs"),
      },
    });
    cleanups.push(() => app.close());
    app.process().stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.includes("[desktop]")) console.log(text);
    });
    await app.evaluate(() => {
      const harness: unknown = Reflect.get(globalThis, "harness");
      const start = typeof harness === "object" && harness ? Reflect.get(harness, "start") : 0;
      if (typeof start !== "function") throw new Error("No video harness");
      Reflect.apply(start, harness, []);
    });

    const threadId = "video-thread";
    await expect
      .poll(
        async () => {
          try {
            return (await service.open({ threadId, workspaceId: "video-workspace" })).backend;
          } catch {
            return "unregistered";
          }
        },
        { timeout: 30_000 },
      )
      .toBe("embedded");
    await service.execute(threadId, {
      action: "navigate",
      url: `http://127.0.0.1:${address.port}/`,
    });
    await service.execute(threadId, { action: "resize", width: 1280, height: 800 });

    const tally = { chunks: 0, keyframes: 0, bytes: 0, counting: false, frames: 0 };
    const keys: { description: Uint8Array | undefined; nals: number[] }[] = [];
    const assembler = new StreamAssembler();
    const bridge = connectBrowser(service, {
      connectionId: "remote-viewer",
      authorize: () => true,
      send: () => true,
      sendStream: (pieces) => {
        for (const piece of pieces) {
          const envelope = assembler.push(piece);
          const message = envelope && decodeStreamMessage(envelope);
          if (!message) continue;
          if (message.kind === "browser.video") {
            const { chunk } = message;
            if (chunk.key)
              keys.push({ description: chunk.description, nals: nalTypes(chunk.bytes) });
            if (tally.counting) {
              tally.chunks++;
              tally.bytes += chunk.bytes.length;
              if (chunk.key) tally.keyframes++;
            }
          } else if (message.kind === "browser.frame" && tally.counting) tally.frames++;
          if (message.kind !== "browser.video" && message.kind !== "browser.frame") continue;
          const sequence =
            message.kind === "browser.video" ? message.chunk.sequence : message.frame.sequence;
          const video = message.kind === "browser.video";
          // Acked a moment later, as a client does, never from inside the send.
          setTimeout(
            () =>
              void bridge.handle({
                type: "browser.ack",
                threadId,
                requestId: `ack-${sequence}`,
                sequence,
                ...(video ? { video: true } : {}),
              }),
            5,
          );
        }
        return true;
      },
    });
    cleanups.push(() => bridge.close());
    await bridge.handle({
      type: "browser.subscribe",
      threadId,
      requestId: "subscribe",
      binaryFrames: true,
      viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
      video: { codecs: ["avc1.42E033"] },
    });
    await expect.poll(() => keys.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const seconds = 5;
    tally.counting = true;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    tally.counting = false;
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
