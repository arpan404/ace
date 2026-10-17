import { z } from "zod";
import type { UserBrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserBackendSession } from "./backend.ts";
import { cancellableCdp } from "./cancellable-cdp.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { chromeInput } from "./chrome-input.ts";
import { consoleEntry } from "./console-entry.ts";
import { modelScreenshot } from "./model-screenshot.ts";
import { pageStatus } from "./page-status.ts";
import type { UserChromeLink } from "./user-chrome-link.ts";

const Navigated = z.object({
  frame: z.object({ id: z.string(), url: z.string().max(8192), parentId: z.string().optional() }),
});
const SameDocument = z.object({ frameId: z.string(), url: z.string().max(8192) });
const Response = z.object({
  response: z.object({ url: z.string().max(8192), status: z.number() }),
});
const Failed = z.object({ errorText: z.string().max(8192) });
const Layout = z.object({
  cssLayoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
});
const Counted = z.object({ result: z.object({ value: z.number() }) });
/** Counts the document's nodes, stopping just past the snapshot limit. */
const countNodes = `(() => {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  let nodes = 1;
  while (nodes <= 20001 && walker.nextNode()) nodes++;
  return nodes;
})()`;

/** The daemon socket carries at most 1 MiB; a PNG near that is refused by the extension's host. */
const Png = z.object({ data: z.string().max(960 * 1024) });

const lossReasons: Record<string, string> = {
  closed: "The tab was closed in your browser",
  revoked: "You stopped sharing this tab",
  stopped: "You stopped ace in your browser",
  canceled: "You cancelled debugging in your browser",
  sensitive: "The tab opened a page ace never controls",
  unreachable: "Your browser lost its connection to ace",
  disconnected: "Your browser disconnected from ace",
};

/**
 * One tab of the person's browser as a backend session (ADR 0084). Commands go through the same
 * CDP building blocks as ace's own Chrome. There is no request interception: the extension
 * enforces which pages may load, and the person's own browsing never waits on the daemon.
 */
export async function userTabSession(
  link: UserChromeLink,
  tab: UserBrowserTab,
  request: BackendOpen,
  platform: NodeJS.Platform,
): Promise<BrowserBackendSession> {
  const tabCdp = link.tab(tab.tabId);
  // Extensions get no Memory domain; the snapshot and text-wait size guards count nodes instead.
  const cdp: typeof tabCdp = {
    ...tabCdp,
    send: async (method, params) => {
      if (method !== "Memory.getDOMCounters") return tabCdp.send(method, params);
      const counted = Counted.parse(
        await tabCdp.send("Runtime.evaluate", { expression: countNodes, returnByValue: true }),
      );
      return { documents: 1, nodes: counted.result.value, jsEventListeners: 0 };
    },
  };
  const lifetime = new AbortController();
  const signal = AbortSignal.any([request.signal, lifetime.signal]);
  let url = tab.url;
  let mainFrame: string | undefined;
  let viewport = { width: 1280, height: 720 };
  let closing: Promise<void> | undefined;
  const stopDetached = cdp.onDetached((reason) => {
    if (closing) return;
    lifetime.abort(new Error(lossReasons[reason] ?? "Your browser tab is gone"));
    request.lost(lossReasons[reason] ?? "Your browser tab is gone");
  });
  cdp.on("Page.frameNavigated", (raw) => {
    const parsed = Navigated.safeParse(raw);
    if (!parsed.success || parsed.data.frame.parentId) return;
    mainFrame = parsed.data.frame.id;
    url = parsed.data.frame.url;
    request.navigation();
  });
  cdp.on("Page.navigatedWithinDocument", (raw) => {
    const parsed = SameDocument.safeParse(raw);
    if (!parsed.success || (mainFrame && parsed.data.frameId !== mainFrame)) return;
    url = parsed.data.url;
    request.navigation();
  });
  for (const method of ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"])
    cdp.on(method, (raw) => {
      const entry = consoleEntry(method, raw);
      if (entry) request.log(entry);
    });
  cdp.on("Network.responseReceived", (raw) => {
    const parsed = Response.safeParse(raw);
    if (parsed.success)
      request.log({
        kind: "network",
        type: "response",
        text: `${parsed.data.response.status} ${parsed.data.response.url}`,
      });
  });
  cdp.on("Network.loadingFailed", (raw) => {
    const parsed = Failed.safeParse(raw);
    if (parsed.success)
      request.log({ kind: "network", type: "failed", text: parsed.data.errorText });
  });
  const status = pageStatus(cdp, () => request.changed?.());
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      lifetime.abort(new Error("Browser session closed"));
      stopDetached();
      status.close();
      cdp.dispose();
      if (link.closed) return;
      // An agent's tab goes away with its session; a person's shared tab stays theirs.
      const operation =
        tab.access === "agent"
          ? ({ op: "tabs.close", tabId: tab.tabId } as const)
          : ({ op: "tabs.detach", tabId: tab.tabId } as const);
      await link.command(operation).catch(() => {});
    })());
  try {
    for (const domain of ["Page.enable", "Runtime.enable", "Network.enable"])
      await cdp.send(domain);
    const layout = Layout.parse(await cdp.send("Page.getLayoutMetrics")).cssLayoutViewport;
    viewport = { width: Math.round(layout.clientWidth), height: Math.round(layout.clientHeight) };
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  const input = chromeInput(() => cdp, platform);
  const stopLoading = () => void cdp.send("Page.stopLoading").catch(() => {});
  return {
    get cdp() {
      return cancellableCdp(cdp, signal);
    },
    pageStatus: () => status.read(),
    url: () => url,
    navigate: async (target, _timeout, navigation) => {
      if (!(await request.allowed(target, { navigation: true })))
        throw new Error("Navigation blocked");
      navigation?.addEventListener("abort", stopLoading, { once: true });
      try {
        await navigateCdp(cdp, target, navigation ? AbortSignal.any([signal, navigation]) : signal);
      } finally {
        navigation?.removeEventListener("abort", stopLoading);
      }
    },
    click: (x, y) => input.click(x, y),
    insertText: (text) => input.insertText(text),
    press: (key) => input.press(key),
    wheel: (x, y) => input.wheel(x, y),
    screenshot: async (format) => {
      if (format === "jpeg") return modelScreenshot(cdp);
      const { data } = Png.parse(await cdp.send("Page.captureScreenshot", { format: "png" }));
      return Buffer.from(data, "base64");
    },
    resize: async (width, height) => {
      // A person's shared tab keeps the size of their window.
      if (tab.access !== "agent") return;
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 0,
        mobile: false,
      });
      viewport = { width, height };
    },
    viewport: () => viewport,
    media: async (colorScheme) => {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    },
    close,
  };
}
