import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { BrowserOpen } from "@ace/protocol";
import type { ViewPage } from "../../src/main/browser/backend.ts";
import { EmbeddedViews } from "../../src/main/browser/views.ts";

/*
 * An Electron main for `native-input.e2e.ts`: the app's real embedded view host in a window,
 * with a page that records what reaches it. `globalThis.harness` is driven from the test
 * through Playwright's `app.evaluate`.
 */

if (process.env.ACE_E2E_USER_DATA) app.setPath("userData", process.env.ACE_E2E_USER_DATA);

/** Records each mousedown position and keydown key the page receives, in order. */
const recorder = `<!doctype html><body style="margin:0;height:100vh"><input autofocus style="position:absolute;left:10px;top:10px">
<script>window.received=[];
addEventListener("mousedown",e=>received.push("click "+e.clientX+","+e.clientY),true);
addEventListener("keydown",e=>received.push("key "+e.key),true);</script></body>`;

let page: ViewPage | undefined;
let contents: WebContents | undefined;

async function start(): Promise<void> {
  const window = new BrowserWindow({ width: 900, height: 700, show: true });
  await window.loadURL("about:blank");
  const views = new EmbeddedViews({ window: () => window, platform: process.platform, log: () => {} });
  const known = new Set(webContents.getAllWebContents().map((each) => each.id));
  page = await views.open({
    sessionId: "session-1",
    options: BrowserOpen.parse({ threadId: "thread-1", workspaceId: "workspace-1" }),
    viewport: { width: 600, height: 500 },
  });
  contents = webContents.getAllWebContents().find((each) => !known.has(each.id));
  views.place(
    { threadId: "thread-1", bounds: { x: 0, y: 0, width: 600, height: 500 }, visible: true },
    { id: window.webContents.id, window, zoom: 1 },
  );
  await page.navigate(`data:text/html,${encodeURIComponent(recorder)}`, 15_000);
  page.setNativeInput(false);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The harness has not started");
  return value;
}

/** The person's own click and key, delivered to the view as the OS would. */
function localInput(x: number, y: number, key: string): void {
  const target = required(contents);
  target.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  target.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  target.sendInputEvent({ type: "keyDown", keyCode: key });
  target.sendInputEvent({ type: "keyUp", keyCode: key });
}

/** A click relayed from the daemon (an agent's, or a remote lease owner's) through CDP. */
function relayedClick(x: number, y: number): Promise<unknown> {
  const target = required(page);
  const click = (type: string) =>
    target.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  return Promise.all([click("mousePressed"), click("mouseReleased")]);
}

const harness = {
  start,
  /** Whether the lease lets the person's own input through (the backend's verdict). */
  setNativeInput: (enabled: boolean) => required(page).setNativeInput(enabled),
  localInput,
  /** Relayed input in flight while the person clicks and types locally at the same moment. */
  async relayedDuringLocal(local: { x: number; y: number; key: string }): Promise<void> {
    const target = required(page);
    const relayed = Promise.all([relayedClick(40, 40), target.press("a")]);
    localInput(local.x, local.y, local.key);
    await relayed;
  },
  relayedClick: async (x: number, y: number) => {
    await relayedClick(x, y);
  },
  async received(): Promise<string[]> {
    // Let the renderer handle what was sent before reading.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await required(page).cdp("Runtime.evaluate", {
      expression: "JSON.stringify(received)",
      returnByValue: true,
    });
    const value =
      typeof result === "object" && result !== null && "result" in result
        ? (result.result as { value?: unknown }).value
        : undefined;
    return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
  },
  async reset(): Promise<void> {
    await required(page).cdp("Runtime.evaluate", { expression: "received.length = 0" });
  },
};

Reflect.set(globalThis, "harness", harness);
void app.whenReady();
