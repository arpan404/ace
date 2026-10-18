import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import type { BrowserFrame, BrowserState } from "@ace/protocol";
import { pixel } from "./annotation-test-support.ts";
import type { Actor } from "./session.ts";
import type { BrowserServiceOptions } from "./service-options.ts";
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
 * A thread browser with agent cursors on, a person watching its live frames with a magenta
 * accent, and helpers to look for the cursor in what each side sees.
 */
export async function cursorFixture(options: Partial<BrowserServiceOptions> = {}) {
  const server = createServer((request, response) => {
    const body = pages[request.url ?? "/"];
    if (!body) return void response.writeHead(404).end();
    response.setHeader("Content-Type", "text/html");
    response.end(body);
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
  const frames: BrowserFrame[] = [];
  const states: BrowserState[] = [];
  f.service.subscribe(
    "thread",
    "person",
    {
      send: (frame) => {
        frames.push(frame);
        // Ask for the next frame at once, as a viewer that keeps up does.
        queueMicrotask(() => f.service.acknowledge("thread", "person", frame.sequence));
        return true;
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
    local: true,
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
  const frameImage = async () => {
    const latest = frames.at(-1);
    if (!latest) throw new Error("No live frame yet");
    const { default: sharp } = await import("sharp");
    const data = Buffer.from(latest.data, "base64");
    return { data: latest.data, width: (await sharp(data).metadata()).width ?? 0 };
  };
  return {
    ...f,
    origin,
    frames,
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
