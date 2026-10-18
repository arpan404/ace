import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { z } from "zod";
import {
  BrowserAnnotationEvent,
  type BrowserCommand,
  type BrowserServerMessage,
} from "@ace/protocol";
import { BrowserService, connectBrowser, detectChromium } from "./index.ts";
import type { EmbeddedBackend, EmbeddedTransport } from "./embedded.ts";

export const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

/** Pages written for these tests; nothing here mentions the overlay's own labels. */
export const pages: Record<string, { headers?: Record<string, string>; body: string }> = {
  "/": {
    body: `<!doctype html><title>Pricing</title>
<body style="margin:0;font:16px sans-serif;background:#fff">
<main><section class="hero"><p class="lead" style="margin:40px;width:300px">Start your free trial</p>
<p class="lead" style="margin:40px;width:300px">Second lead</p></section>
<div id="scroller" style="margin:40px;height:200px;width:400px;overflow:auto">
<div style="height:600px"></div><p id="deep" style="margin:0 0 0 40px;width:200px;height:40px;background:#eee">Deep item</p>
<div style="height:600px"></div></div>
<a href="/next">Next page</a></main>
<script>window.pageClicks=0;document.addEventListener('click',()=>window.pageClicks++);</script>
</body>`,
  },
  "/csp": {
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    },
    body: `<!doctype html><title>Locked</title><body><h1>Locked down</h1><p class="note">Strict page</p>
<script>window.pageClicks=0;document.addEventListener('click',()=>window.pageClicks++);</script></body>`,
  },
  "/styles": {
    body: `<!doctype html><title>Styles</title>
<body style="margin:0;font:16px/20px sans-serif;background:#fff">
<h1 id="title" style="margin:80px 60px 20px;font-size:28px;color:rgb(10, 20, 30)">Hello title</h1>
<p id="lead" style="margin:20px 60px;width:400px;opacity:0.9 !important">Lead <b>bold</b> words</p>
<p id="note" style="margin:20px 60px;width:400px">Note text</p>
</body>`,
  },
  "/framed": {
    body: `<!doctype html><title>Framed</title><body style="margin:0">
<iframe id="embed" style="margin:40px;width:300px;height:150px;border:0"
 srcdoc="<body style='margin:0;height:100%'><script>window.frameClicks=0;addEventListener('click',()=>frameClicks++)</script></body>"></iframe>
</body>`,
  },
  "/region": {
    body: `<!doctype html><title>Region</title>
<body style="margin:0;font:16px/20px sans-serif;background:#fff;height:3000px">
<section id="card" style="position:absolute;left:100px;top:100px;width:400px;height:200px">
<h2 id="heading" style="position:absolute;left:20px;top:20px;margin:0;font-size:20px">Plans</h2>
<button id="start" style="position:absolute;left:20px;top:70px;width:120px;height:32px">Get started</button>
<p id="copy" style="position:absolute;left:20px;top:130px;margin:0;width:300px">Cancel any time</p>
</section>
<p id="outside" style="position:absolute;left:100px;top:420px;margin:0">Outside text</p>
<script>window.pageClicks=0;window.pageDowns=0;window.buttonClicks=0;
document.addEventListener('click',()=>pageClicks++);
document.addEventListener('pointerdown',()=>pageDowns++);
document.addEventListener('mousedown',()=>pageDowns++);
document.getElementById('start').addEventListener('click',()=>buttonClicks++);</script>
</body>`,
  },
  "/next": {
    body: `<!doctype html><title>Next</title><body><h2>Another document</h2>
<script>window.pageClicks=0;document.addEventListener('click',()=>window.pageClicks++);</script></body>`,
  },
};

function serve(request: IncomingMessage, response: ServerResponse): void {
  const page = pages[request.url ?? "/"];
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  for (const [name, value] of Object.entries(page.headers ?? {})) response.setHeader(name, value);
  response.end(page.body);
}

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type Box = z.infer<typeof Box>;

/** A desktop stand-in to register before the page opens; the page then runs embedded. */
export interface DesktopStandIn {
  transport: EmbeddedTransport;
  attach(backend: EmbeddedBackend): void;
}

/** A person's connection to the thread's browser over the real bridge, plus page helpers. */
export async function annotationFixture(desktop?: DesktopStandIn) {
  const home = await mkdtemp(join(tmpdir(), "ace-annotate-"));
  const server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    ...(desktop ? { backendPreference: () => "embedded" as const } : {}),
  });
  if (desktop) desktop.attach(service.registerEmbedded(desktop.transport));
  cleanups.push(async () => {
    try {
      await service.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  await service.execute("thread", { action: "navigate", url: `${origin}/` });
  let request = 0;
  function connect(connectionId: string) {
    const messages: BrowserServerMessage[] = [];
    const bridge = connectBrowser(service, {
      connectionId,
      authorize: () => true,
      send: (message) => {
        messages.push(message);
        return true;
      },
    });
    const call = async (message: Record<string, unknown>): Promise<unknown> => {
      const requestId = `r${++request}`;
      await bridge.handle({ requestId, threadId: "thread", ...message });
      const result = messages.find(
        (candidate) => candidate.type === "browser.result" && candidate.requestId === requestId,
      );
      if (result?.type !== "browser.result") throw new Error("No browser result");
      if (!result.ok) throw new Error(result.error);
      return result.result;
    };
    const events = () =>
      messages.flatMap((message) =>
        message.type === "browser.annotation" ? [BrowserAnnotationEvent.parse(message.event)] : [],
      );
    return {
      messages,
      bridge,
      events,
      execute: (command: BrowserCommand | Record<string, unknown>) =>
        call({ type: "browser.execute", command }),
      subscribe: () => call({ type: "browser.subscribe" }),
      evaluate: (expression: string) =>
        call({ type: "browser.execute", command: { action: "evaluate", expression } }),
      async event<K extends BrowserAnnotationEvent["kind"]>(kind: K, after = 0) {
        return vi.waitFor(
          () => {
            const found = events()
              .slice(after)
              .find((event) => event.kind === kind);
            if (!found) throw new Error(`No ${kind} event yet`);
            return found as Extract<BrowserAnnotationEvent, { kind: K }>;
          },
          { timeout: 10_000, interval: 25 },
        );
      },
      async box(selector: string): Promise<Box> {
        return Box.parse(
          await call({
            type: "browser.execute",
            command: {
              action: "evaluate",
              expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
            },
          }),
        );
      },
      /** As the web client sends it: a hover move without buttons, then press and release. */
      async click(x: number, y: number) {
        await call({
          type: "browser.input",
          input: { kind: "mouse", event: "mouseMoved", x, y, button: "none" },
        });
        for (const event of ["mousePressed", "mouseReleased"])
          await call({ type: "browser.input", input: { kind: "mouse", event, x, y } });
      },
      async type(text: string) {
        await call({ type: "browser.input", input: { kind: "key", event: "char", key: text } });
      },
      async press(key: string, options: { code?: string; modifiers?: number } = {}) {
        const { code = key, modifiers = 0 } = options;
        for (const event of ["keyDown", "keyUp"])
          await call({
            type: "browser.input",
            input: { kind: "key", event, key, code, modifiers },
          });
      },
      /** One mouse button event without the hover move, e.g. to hold a button down. */
      async mouse(event: "mousePressed" | "mouseReleased", x: number, y: number) {
        await call({ type: "browser.input", input: { kind: "mouse", event, x, y } });
      },
      /** A pointer move; with the left button it continues a press into a drag. */
      async move(x: number, y: number, button: "none" | "left") {
        await call({
          type: "browser.input",
          input: { kind: "mouse", event: "mouseMoved", x, y, button },
        });
      },
      /** Press, move in steps and release: a drag as a person's mouse makes it. */
      async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 6) {
        await call({
          type: "browser.input",
          input: { kind: "mouse", event: "mouseMoved", ...from, button: "none" },
        });
        await call({
          type: "browser.input",
          input: { kind: "mouse", event: "mousePressed", ...from },
        });
        for (let step = 1; step <= steps; step++)
          await call({
            type: "browser.input",
            input: {
              kind: "mouse",
              event: "mouseMoved",
              x: from.x + ((to.x - from.x) * step) / steps,
              y: from.y + ((to.y - from.y) * step) / steps,
              button: "left",
            },
          });
        await call({
          type: "browser.input",
          input: { kind: "mouse", event: "mouseReleased", ...to },
        });
      },
      /** One key event, e.g. to hold Space down across other input. */
      async key(event: "keyDown" | "keyUp", key: string, code = key) {
        await call({ type: "browser.input", input: { kind: "key", event, key, code } });
      },
      async scroll(x: number, y: number, deltaY: number) {
        await call({
          type: "browser.input",
          input: { kind: "scroll", x, y, deltaX: 0, deltaY },
        });
      },
    };
  }
  /** A person who has subscribed and started annotate mode. */
  async function annotating(connectionId = "person") {
    const person = connect(connectionId);
    await person.subscribe();
    await person.execute({ action: "annotate", operation: "start", config: { theme: "dark" } });
    await person.event("ready");
    return person;
  }
  /** Click the centre of `selector`, type a comment and press Enter. */
  async function pin(person: ReturnType<typeof connect>, selector: string, comment: string) {
    const before = person.events().length;
    const box = await person.box(selector);
    await person.click(box.x + box.width / 2, box.y + box.height / 2);
    await person.type(comment);
    await person.press("Enter");
    return (await person.event("saved", before)).annotation;
  }
  return { service, origin, connect, annotating, pin };
}

/** Centre of an element's marker: just outside its top-left corner, clear of its text. */
export function markerCentre(box: Box): { x: number; y: number } {
  return { x: box.x - 11, y: box.y - 11 };
}

/** RGB of one CSS pixel in a JPEG/PNG capture of the viewport. */
export async function pixel(
  image: { data: string; width: number },
  viewportWidth: number,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const { default: sharp } = await import("sharp");
  const scale = image.width / viewportWidth;
  const { data, info } = await sharp(Buffer.from(image.data, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const index = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
  return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
}

/** ace's light accent (#3065CC), which markers use on every page. */
export function isMarkerBlue([r, g, b]: [number, number, number]): boolean {
  return Math.abs(r - 0x30) < 40 && Math.abs(g - 0x65) < 40 && Math.abs(b - 0xcc) < 40;
}
