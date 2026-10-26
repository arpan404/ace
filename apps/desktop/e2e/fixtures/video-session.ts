import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { expect } from "vitest";
import { BrowserService, connectBrowser } from "@ace/browser";
import { decodeStreamMessage, StreamAssembler, type BrowserVideoChunk } from "@ace/browser/stream";
import { appEnvironment, desktop, electronBinary } from "../../scripts/common.ts";
import { credential, relayDaemon, token } from "../../src/main/browser/relay-test-support.ts";

/*
 * One remote-viewer video session for the desktop e2e tests (ADR 0088, embedded backend): the
 * app's views, backend, connection and encoder (`video-main.ts`) in real Electron, registered
 * with a daemon's `BrowserService` over a real socket, an HTTP server for the pages, and a
 * thread whose tab the desktop serves.
 */

export const threadId = "video-thread";

export interface VideoSession {
  app: ElectronApplication;
  service: BrowserService;
  /** The pages' server, as `http://127.0.0.1:<port>`: a secure context, as WebCodecs needs. */
  origin: string;
}

/** Starts the session; `pages` maps a path to its HTML. Everything stops with `cleanups`. */
export async function startVideoSession(
  cleanups: (() => unknown)[],
  pages: Record<string, string>,
): Promise<VideoSession> {
  const out = await mkdtemp(join(tmpdir(), "ace-e2e-video-build-"));
  const home = await mkdtemp(join(tmpdir(), "ace-e2e-video-home-"));
  cleanups.push(() => rm(out, { recursive: true, force: true }));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const shared = { bundle: true, external: ["electron"], logLevel: "warning" as const };
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

  const server = createServer((request, response) => {
    const page = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    response.statusCode = page === undefined ? 404 : 200;
    response.setHeader("Content-Type", "text/html");
    response.end(page ?? "Not found");
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
  const app = await electron.launch({
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
  return { app, service, origin: `http://127.0.0.1:${address.port}` };
}

export interface VideoViewer {
  /** JPEG frames received, which a video subscription should not get. */
  frames(): number;
}

/**
 * A remote viewer subscribed to the thread's video, acking as a client does; every video
 * chunk goes to `onChunk`.
 */
export async function watchVideo(
  cleanups: (() => unknown)[],
  service: BrowserService,
  options: {
    viewport: { width: number; height: number };
    codecs: string[];
    onChunk(chunk: BrowserVideoChunk): void;
  },
): Promise<VideoViewer> {
  let frames = 0;
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
        if (message.kind === "browser.video") options.onChunk(message.chunk);
        else if (message.kind === "browser.frame") frames++;
        else continue;
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
    viewport: { ...options.viewport, devicePixelRatio: 1 },
    video: { codecs: options.codecs },
  });
  return { frames: () => frames };
}
