import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import type { BrowserState } from "@ace/protocol";
import { pixel } from "./annotation-test-support.ts";
import type { Actor } from "./session.ts";
import type { BrowserServiceOptions } from "./service-options.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { fixture } from "./test-support.ts";

export { executablePath } from "./test-support.ts";

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

/** A colour no fixture page uses: the person's accent in these tests. */
export const accent = "#FF00FF";
export const agent: Actor = { kind: "agent", agentId: "helper" };

/** Fixture pages; nothing on them is magenta. */
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Start</title><body style="margin:0;background:#fff;font:16px sans-serif">
<button id="go" style="position:absolute;left:200px;top:150px;width:120px;height:40px">Go</button>
<a id="next" href="/next" style="position:absolute;left:200px;top:300px">Next page</a>
<label style="position:absolute;left:200px;top:400px">Name <input id="name" aria-label="Name"></label>
<script>window.pageClicks=0;document.getElementById('go').addEventListener('click',()=>pageClicks++);</script>
</body>`,
  "/next": `<!doctype html><title>Next</title><body style="margin:0;background:#fff"><h1>Another document</h1></body>`,
  "/login": `<!doctype html><title>Sign in</title><body style="margin:0;background:#fff;font:32px monospace">
<input id="password" type="password" aria-label="Password" style="position:absolute;left:40px;top:40px;width:400px;height:60px;border:0;outline:0;background:#fff;color:#000;font:32px monospace;padding:0 8px">
<input id="shown" type="text" autocomplete="current-password" aria-label="Shown password" style="position:absolute;left:40px;top:160px;width:400px;height:60px;border:0;outline:0;background:#fff;color:#000;font:32px monospace;padding:0 8px">
</body>`,
};

const magenta = ([r, g, b]: [number, number, number]) => r > 190 && g < 110 && b > 190;

async function bytesImage(bytes: Uint8Array) {
  const { default: sharp } = await import("sharp");
  const data = Buffer.from(bytes);
  return { data: data.toString("base64"), width: (await sharp(data).metadata()).width ?? 0 };
}

/**
 * Decodes one keyframe with WebCodecs in a page of its own and returns the picture as a PNG:
 * what the person's screen shows for it.
 */
const decodeKeyframe = (chunk: BrowserVideoChunk) => {
  const config = {
    codec: chunk.codec,
    codedWidth: chunk.codedWidth,
    codedHeight: chunk.codedHeight,
    ...(chunk.description
      ? { description: Buffer.from(chunk.description).toString("base64") }
      : {}),
  };
  return `(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const config = ${JSON.stringify(config)};
    let picture;
    const errors = [];
    const decoder = new VideoDecoder({
      output: (frame) => { picture?.close(); picture = frame; },
      error: (error) => errors.push(String(error)),
    });
    decoder.configure({ ...config, ...(config.description ? { description: bytes(config.description) } : {}) });
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: bytes(${JSON.stringify(Buffer.from(chunk.bytes).toString("base64"))}) }));
    await decoder.flush().catch((error) => errors.push(String(error)));
    if (!picture) throw new Error("No picture: " + errors.join("; "));
    const canvas = new OffscreenCanvas(picture.displayWidth, picture.displayHeight);
    canvas.getContext("2d").drawImage(picture, 0, 0);
    picture.close();
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let text = "";
    for (let index = 0; index < png.length; index += 8192)
      text += String.fromCharCode(...png.subarray(index, index + 8192));
    return btoa(text);
  })()`;
};

/**
 * A thread browser with agent cursors on, a person watching its live video with a magenta
 * accent, and helpers to look for the cursor in what each side sees.
 */
export async function cursorFixture(options: Partial<BrowserServiceOptions> = {}) {
  const server = createServer((request, response) => {
    const body = pages[request.url ?? "/"];
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": "text/html" });
    if (request.url !== "/next") return void response.end(body);
    // The next page commits before its markup arrives, as a slow server's does: the cursor
    // layer has to come back on a document that has no <html> yet.
    response.flushHeaders();
    setTimeout(() => response.end(body), 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  servers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const f = await fixture({
    agentCursor: { glideMs: 60, name: (_thread, agentId) => (agentId ? "Helper" : undefined) },
    ...options,
  });
  const chunks: BrowserVideoChunk[] = [];
  const states: BrowserState[] = [];
  f.service.subscribe(
    "thread",
    "person",
    {
      video: {
        send: (chunk) => {
          chunks.push(chunk);
          // Acknowledge each chunk at once, as a viewer that keeps up does.
          queueMicrotask(() => f.service.acknowledgeVideo("thread", "person", chunk.sequence));
          return true;
        },
      },
    },
    (state) => states.push(state),
  );
  f.service.configureCapture("thread", "person", {
    viewport: {
      width: 800,
      height: 600,
      devicePixelRatio: 1,
      cursor: { fill: accent, outline: "#FFFFFF" },
    },
    video: { codecs: ["avc1.42E033", "vp8"] },
  });
  await f.service.execute("thread", { action: "resize", width: 800, height: 600 });
  await f.service.execute("thread", { action: "navigate", url: `${origin}/` });
  const width = 800;

  /** Whether a JPEG/PNG of the viewport has the accent within a few px of (x, y). */
  const accentNear = async (image: { data: string; width: number }, x: number, y: number) => {
    for (const [dx, dy] of [
      [3, 4],
      [5, 7],
      [6, 9],
      [8, 10],
    ] as const)
      if (magenta(await pixel(image, width, x + dx, y + dy))) return true;
    return false;
  };
  // The person's screen: a page of its own in another thread, where pictures are decoded.
  let screen: Promise<unknown> | undefined;
  /** What the person's live view shows now: a fresh keyframe, decoded. */
  const frameImage = async () => {
    screen ??= f.service
      .open({ threadId: "screen", workspaceId: "workspace" })
      .then(() => f.service.execute("screen", { action: "navigate", url: `${origin}/next` }));
    await screen;
    const asked = chunks.length;
    f.service.acknowledgeVideo("thread", "person", chunks.at(-1)?.sequence ?? 0, true);
    const fresh = () => chunks.slice(asked).find((chunk) => chunk.key);
    await vi.waitFor(() => expect(fresh()).toBeDefined(), { timeout: 5_000, interval: 20 });
    const key = fresh();
    if (!key) throw new Error("No live keyframe");
    const data = z
      .string()
      .parse(
        await f.service.execute("screen", { action: "evaluate", expression: decodeKeyframe(key) }),
      );
    const { default: sharp } = await import("sharp");
    return { data, width: (await sharp(Buffer.from(data, "base64")).metadata()).width ?? 0 };
  };
  return {
    ...f,
    origin,
    states,
    accentNear,
    frameImage,
    bytesImage,
    agentRun: (command: Record<string, unknown>) => f.service.execute("thread", command, agent),
    personRun: (command: Record<string, unknown>) =>
      f.service.execute("thread", command, { kind: "human", connectionId: "person" }),
    /** Waits until the person's live view shows (or stops showing) the cursor at a point. */
    async seen(x: number, y: number, shown: boolean) {
      await vi.waitFor(
        async () => {
          expect(await accentNear(await frameImage(), x, y)).toBe(shown);
        },
        { timeout: 15_000, interval: 50 },
      );
    },
    async box(selector: string) {
      return Box.parse(
        await f.service.execute(
          "thread",
          {
            action: "evaluate",
            expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
          },
          { kind: "human", connectionId: "person" },
        ),
      );
    },
  };
}

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
