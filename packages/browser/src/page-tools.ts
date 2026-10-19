import { z } from "zod";
import type { BrowserCommand, BrowserTabEmulation } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendPage } from "./backend.ts";
import type { Actor } from "./session-options.ts";

/** What a tab shows beyond its page: the device it emulates and its zoom. */
export interface TabView {
  emulation: BrowserTabEmulation | undefined;
  zoom: number;
  /** The person's last resize came from a touch screen: the page has touch events on. */
  touchScreen?: boolean | undefined;
}

/** The longest page source returned; a longer document is cut there. */
export const pageSourceLimit = 2 * 1024 * 1024;

type PageTool = Extract<BrowserCommand, { action: "zoom" | "clear_data" | "page_source" }>;
type Emulate = Extract<BrowserCommand, { action: "emulate" }>;

/** Zoom, clear data and page source belong to the person; agents have no tool for them. */
export async function executePageTool(
  command: PageTool,
  actor: Actor,
  page: BrowserBackendPage,
  view: TabView,
  hooks: { check(): void; read(): void; changed(): void },
): Promise<unknown> {
  if (actor.kind !== "human") throw new BrowserActionError("invalid_arguments");
  switch (command.action) {
    case "zoom": {
      if (!page.zoom) throw new BrowserActionError("not_supported");
      hooks.check();
      await page.zoom(command.factor);
      view.zoom = command.factor;
      hooks.changed();
      return { zoom: command.factor };
    }
    case "clear_data": {
      if (!page.clearData) throw new BrowserActionError("not_supported");
      hooks.check();
      await page.clearData();
      return { ok: true };
    }
    case "page_source":
      hooks.read();
      return pageSource(page);
  }
}

const FrameTree = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string() }) }),
});
const Resource = z.object({ content: z.string(), base64Encoded: z.boolean() });
const Evaluated = z.object({ result: z.object({ value: z.string() }) });

/**
 * The main document as the server sent it (Chrome's resource cache), else the live DOM when
 * the cache no longer holds it. Cut at `pageSourceLimit` characters.
 */
async function pageSource(page: BrowserBackendPage) {
  const { frame } = FrameTree.parse(await page.cdp.send("Page.getFrameTree")).frameTree;
  let source: string;
  let live = false;
  try {
    const resource = Resource.parse(
      await page.cdp.send("Page.getResourceContent", { frameId: frame.id, url: frame.url }),
    );
    source = resource.base64Encoded
      ? Buffer.from(resource.content, "base64").toString("utf8")
      : resource.content;
  } catch {
    live = true;
    source = Evaluated.parse(
      await page.cdp.send("Runtime.evaluate", {
        expression: "document.documentElement ? document.documentElement.outerHTML : ''",
        returnByValue: true,
      }),
    ).result.value;
  }
  return {
    url: frame.url,
    source: source.slice(0, pageSourceLimit),
    truncated: source.length > pageSourceLimit,
    live,
  };
}

/**
 * A device for the tab: its size and scale, touch, color scheme and user agent. Who set it is
 * kept with it, so a person's view can follow an agent's choice.
 */
export async function emulateDevice(
  command: Emulate,
  actor: Actor,
  page: BrowserBackendPage,
  view: TabView,
  check: () => void,
): Promise<void> {
  const device = {
    width: command.width,
    height: command.height,
    deviceScaleFactor: command.deviceScaleFactor,
    mobile: command.mobile,
  };
  check();
  if (page.emulate) await page.emulate(device);
  else {
    await page.resize(command.width, command.height);
    check();
    await page.cdp.send("Emulation.setDeviceMetricsOverride", device);
  }
  check();
  await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: command.touch });
  view.touchScreen = false;
  check();
  await page.media(command.colorScheme);
  // An empty override gives the browser its own user agent back.
  if (command.userAgent !== undefined || view.emulation?.userAgent !== undefined) {
    check();
    await page.cdp.send("Emulation.setUserAgentOverride", { userAgent: command.userAgent ?? "" });
  }
  view.emulation = {
    ...device,
    touch: command.touch,
    ...(command.userAgent ? { userAgent: command.userAgent } : {}),
    by: actor.kind,
  };
}

/**
 * A plain resize. An agent's is a size the person's view should show; the person's own puts
 * the page back on the pane's size, so touch and user agent go back to the browser's own. A
 * person on a touch screen (`touch`) gets the pane's size as a mobile viewport with touch
 * events, where the backend can lay a tab out as a device (ace's Chrome).
 */
export async function resizePage(
  {
    width,
    height,
    touch: touchScreen,
    devicePixelRatio,
  }: {
    width: number;
    height: number;
    touch?: boolean | undefined;
    devicePixelRatio?: number | undefined;
  },
  actor: Actor,
  page: BrowserBackendPage,
  view: TabView,
  check: () => void,
): Promise<void> {
  const size = { width, height };
  const touch = actor.kind === "human" && touchScreen === true;
  check();
  // The viewer's density first, so a touch layout below renders that sharp too.
  await page.resize(width, height, devicePixelRatio);
  if (touch && page.emulate) {
    check();
    // Scale 0 keeps the browser's own device scale, as the plain resize does.
    await page.emulate({
      width: size.width,
      height: size.height,
      deviceScaleFactor: 0,
      mobile: true,
    });
  }
  const previous = view.emulation;
  if (touch !== (previous?.touch === true || view.touchScreen === true)) {
    check();
    await page.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch });
  }
  if (previous?.userAgent !== undefined) {
    check();
    await page.cdp.send("Emulation.setUserAgentOverride", { userAgent: "" });
  }
  view.touchScreen = touch;
  view.emulation =
    actor.kind === "agent"
      ? { ...size, deviceScaleFactor: 1, mobile: false, touch: false, by: "agent" }
      : undefined;
}
