import { z } from "zod";
import { BrowserDialog, type UserBrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserBackendSession } from "./backend.ts";
import { cancellableCdp } from "./cancellable-cdp.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { chromeInput } from "./chrome-input.ts";
import { consoleEntry } from "./console-entry.ts";
import { modelScreenshot } from "./model-screenshot.ts";
import { pageStatus } from "./page-status.ts";
import { countingDomNodes } from "./user-chrome-dom-counters.ts";
import { userTabFrames } from "./user-chrome-frames.ts";
import { personInputWatch } from "./person-input-watch.ts";
import type { UserChromeLink } from "./user-chrome-link.ts";

const Navigated = z.object({
  frame: z.object({ id: z.string(), url: z.string().max(8192), parentId: z.string().optional() }),
});
const FrameTree = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string().max(8192) }) }),
});
const SameDocument = z.object({ frameId: z.string(), url: z.string().max(8192) });
const Response = z.object({
  response: z.object({ url: z.string().max(8192), status: z.number() }),
});
const Failed = z.object({ errorText: z.string().max(8192) });
const DialogOpening = z.object({
  type: BrowserDialog.shape.type,
  message: z.string(),
  defaultPrompt: z.string().optional(),
});
/** A dialog the tab's page raised; `serial` tells one from the next. */
export type UserTabDialog = Pick<BrowserDialog, "type" | "message" | "defaultPrompt"> & {
  serial: number;
};

/** One tab of the person's browser: a backend session that also knows its title and dialog. */
export interface UserTabSession extends BrowserBackendSession {
  /** The browser's own id for the tab. */
  readonly tabId: number;
  title(): string;
  /** An alert, confirm or prompt waiting for an answer. */
  dialog(): UserTabDialog | undefined;
  answerDialog(accept: boolean, promptText?: string): Promise<void>;
}
const Layout = z.object({
  cssLayoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
});

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
): Promise<UserTabSession> {
  const tabCdp = link.tab(tab.tabId);
  // The extension's debugger sees no real input: a watcher in the page reports the person's.
  const person = personInputWatch(() => link.clock.now());
  const cdp: typeof tabCdp = {
    ...tabCdp,
    send: person.agentInput(countingDomNodes(tabCdp.send)),
  };
  const lifetime = new AbortController();
  const signal = AbortSignal.any([request.signal, lifetime.signal]);
  let url = tab.url;
  let mainFrame: string | undefined;
  let viewport = { width: 1280, height: 720 };
  let closing: Promise<void> | undefined;
  let dialog: UserTabDialog | undefined;
  let dialogs = 0;
  let stopWatching: (() => void) | undefined;
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
  cdp.on("Page.javascriptDialogOpening", (raw) => {
    const parsed = DialogOpening.safeParse(raw);
    if (!parsed.success) return;
    // An agent leaving a page only it used, in its own tab, goes unasked; else the person decides.
    if (
      parsed.data.type === "beforeunload" &&
      tab.access === "agent" &&
      request.leaveUnasked?.() === true
    ) {
      void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      return;
    }
    dialog = {
      serial: ++dialogs,
      type: parsed.data.type,
      message: parsed.data.message.slice(0, 4096),
      ...(parsed.data.defaultPrompt !== undefined
        ? { defaultPrompt: parsed.data.defaultPrompt.slice(0, 4096) }
        : {}),
    };
    request.changed?.();
  });
  // Answered here, by the person in their browser, or gone with the page.
  cdp.on("Page.javascriptDialogClosed", () => {
    if (!dialog) return;
    dialog = undefined;
    request.changed?.();
  });
  const frames = userTabFrames(tabCdp);
  const status = pageStatus(cdp, () => request.changed?.());
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      lifetime.abort(new Error("Browser session closed"));
      stopDetached();
      stopWatching?.();
      status.close();
      frames.close();
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
    stopWatching = await person.install(cdp, () => request.humanInput?.());
    // The page may have committed before the debugger came (a popup the page just opened).
    const tree = FrameTree.safeParse(await cdp.send("Page.getFrameTree"));
    if (tree.success && mainFrame === undefined) {
      mainFrame = tree.data.frameTree.frame.id;
      url = tree.data.frameTree.frame.url;
    }
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
    tabId: tab.tabId,
    title: () => link.tabs().find((candidate) => candidate.tabId === tab.tabId)?.title ?? tab.title,
    dialog: () => dialog,
    answerDialog: async (accept, promptText) => {
      await cdp.send("Page.handleJavaScriptDialog", {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      });
      dialog = undefined;
      request.changed?.();
    },
    frames: () => frames.list(cancellableCdp(cdp, signal)),
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
