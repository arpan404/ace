import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  BrowserBackendServerMessage,
  BrowserBackendOperation,
} from "@ace/protocol";
import { BrowserBackend } from "../../src/main/browser/backend.ts";
import { EmbeddedViews } from "../../src/main/browser/views.ts";

/*
 * An Electron main for `native-input.e2e.ts`: the app's real browser backend and embedded view
 * host in a window, driven the way the daemon drives them (backend requests: open, controller
 * leases, CDP and key presses), with a page that records what reaches it. `globalThis.harness`
 * is called from the test through Playwright's `app.evaluate`.
 */

if (process.env.ACE_E2E_USER_DATA) app.setPath("userData", process.env.ACE_E2E_USER_DATA);

/** This app's backend connection; a lease owned by it is the person's here. */
const connectionId = "desktop-connection";
const backendId = "backend-1";
const sessionId = "session-1";

/** Records presses, releases and keys, in order; the input keeps the typed text. */
const recorder = `<!doctype html><body style="margin:0;height:100vh">
<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:20px">
<script>window.received=[];
const at=e=>e.clientX+","+e.clientY;
addEventListener("mousedown",e=>received.push("down "+at(e)),true);
addEventListener("mouseup",e=>received.push("up "+at(e)),true);
addEventListener("keydown",e=>received.push("keydown "+e.key),true);
addEventListener("keyup",e=>received.push("keyup "+e.key),true);</script></body>`;

/** The sentinel key the barrier sends; never part of what the tests observe. */
const sentinel = "F24";

const Response = z.object({ result: z.unknown().optional(), error: z.string().optional() });
/** A CDP `Runtime.evaluate` result by value; a missing or null `result` is a failure. */
const Evaluated = z.object({ result: z.object({ value: z.string() }) });
const Thrown = z.object({ exceptionDetails: z.object({ text: z.string() }) });
const Observed = z.object({ received: z.array(z.string()), value: z.string() });

let contents: WebContents | undefined;
let sequence = 0;
const pending = new Map<string, (response: z.infer<typeof Response>) => void>();

const views = new EmbeddedViews({
  window: () => BrowserWindow.getAllWindows()[0],
  platform: process.platform,
  log: () => {},
});
const backend = new BrowserBackend(views, { log: () => {} });

/** One backend request as the daemon sends it; resolves with its result, or throws its error. */
async function request(operation: z.input<typeof BrowserBackendOperation>): Promise<unknown> {
  const id = `request-${++sequence}`;
  const response = new Promise<z.infer<typeof Response>>((resolve) => pending.set(id, resolve));
  backend.handle(
    BrowserBackendServerMessage.parse({
      type: "browser.backend.request",
      backendId,
      sessionId,
      id,
      operation,
    }),
  );
  const { result, error } = await response;
  if (error !== undefined) throw new Error(error);
  return result;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The harness has not started");
  return value;
}

/** The person's own click and key (with its text), delivered to the view as the OS would. */
function localInput(x: number, y: number, key: string): void {
  const target = required(contents);
  target.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  target.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  target.sendInputEvent({ type: "keyDown", keyCode: key });
  target.sendInputEvent({ type: "char", keyCode: key });
  target.sendInputEvent({ type: "keyUp", keyCode: key });
}

/** A click relayed from the daemon (an agent's, or a remote lease owner's) through CDP. */
function relayedClick(x: number, y: number): Promise<unknown> {
  const click = (type: string) =>
    request({
      kind: "cdp",
      method: "Input.dispatchMouseEvent",
      params: { type, x, y, button: "left", clickCount: 1 },
    });
  return Promise.all([click("mousePressed"), click("mouseReleased")]);
}

/**
 * Every input event sent to the view before this has been handled by the page: the view's
 * input queue is FIFO, and CDP answers `Input.dispatchKeyEvent` only once the renderer has
 * handled that event.
 */
async function barrier(): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"])
    await request({
      kind: "cdp",
      method: "Input.dispatchKeyEvent",
      params: { type, key: sentinel, code: sentinel, windowsVirtualKeyCode: 135 },
    });
}

async function evaluate(expression: string): Promise<string> {
  const result = await request({
    kind: "cdp",
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true },
  });
  const thrown = Thrown.safeParse(result);
  if (thrown.success) throw new Error(`The page threw: ${thrown.data.exceptionDetails.text}`);
  return Evaluated.parse(result).result.value;
}

const harness = {
  async start(): Promise<void> {
    backend.attach({
      backendId,
      connectionId,
      send: (serialized) => {
        const message = BrowserBackendClientMessage.parse(JSON.parse(serialized));
        if (message.type === "browser.backend.response") {
          pending.get(message.id)?.(Response.parse(message));
          pending.delete(message.id);
        }
        return true;
      },
    });
    const window = new BrowserWindow({ width: 900, height: 700, show: true });
    await window.loadURL("about:blank");
    const known = new Set(webContents.getAllWebContents().map((each) => each.id));
    await request({
      kind: "open",
      options: { threadId: "thread-1", workspaceId: "workspace-1", profile: "ephemeral" },
      viewport: { width: 600, height: 500 },
      lease: { generation: 0, controller: "agent" },
    });
    contents = webContents.getAllWebContents().find((each) => !known.has(each.id));
    views.place(
      { threadId: "thread-1", bounds: { x: 0, y: 0, width: 600, height: 500 }, visible: true },
      { id: window.webContents.id, window, zoom: 1 },
    );
    await request({
      kind: "navigate",
      url: `data:text/html,${encodeURIComponent(recorder)}`,
      timeout: 15_000,
    });
  },
  /** The daemon's controller lease for the page; `desktop-connection` is this app's. */
  async lease(generation: number, controller: "agent" | "human", owner?: string): Promise<void> {
    await request({
      kind: "controller",
      lease: { generation, controller, ...(owner ? { owner } : {}) },
    });
  },
  localInput,
  /** Relayed input in flight (a CDP click and a key press) while the person clicks and types. */
  async relayedDuringLocal(local: { x: number; y: number; key: string }): Promise<void> {
    const relayed = Promise.all([
      relayedClick(20, 20),
      request({ kind: "press", key: "a" }),
    ]);
    // Once the relayed commands have been dispatched and await the renderer.
    await new Promise((resolve) => setImmediate(resolve));
    localInput(local.x, local.y, local.key);
    await relayed;
  },
  relayedClick: async (x: number, y: number) => {
    await relayedClick(x, y);
  },
  /** What reached the page (after a barrier), and the text field's value. */
  async observed(): Promise<z.infer<typeof Observed>> {
    await barrier();
    const raw = await evaluate(
      `JSON.stringify({ received, value: document.getElementById("field").value })`,
    );
    const observed = Observed.parse(JSON.parse(raw));
    return {
      received: observed.received.filter((entry) => !entry.endsWith(sentinel)),
      value: observed.value,
    };
  },
  async reset(): Promise<void> {
    await barrier();
    await evaluate(
      `(() => { received.length = 0; const field = document.getElementById("field"); field.value = ""; field.focus(); return "ok"; })()`,
    );
  },
};

Reflect.set(globalThis, "harness", harness);
void app.whenReady();
