/*
 * The video extension's service worker (ADR 0088). The daemon calls `aceVideo.open` over CDP
 * (`Runtime.evaluate` on this worker) to get a capture id for the tab shown in a window; the
 * offscreen document opens and encodes it. Nothing else runs here.
 */

interface ChromeTab {
  id?: number;
}
interface VideoChrome {
  tabs: { query(query: { windowId: number; active: boolean }): Promise<ChromeTab[]> };
  tabCapture: { getMediaStreamId(options: { targetTabId: number }): Promise<string> };
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(options: {
      url: string;
      reasons: readonly string[];
      justification: string;
    }): Promise<void>;
  };
}
declare const chrome: VideoChrome;

let creating: Promise<void> | undefined;

async function offscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Encodes ace's browser tabs as video for ace's own viewers.",
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

Object.assign(globalThis, {
  aceVideo: {
    /** The offscreen document exists and `streamId` captures the tab shown in `windowId`. */
    async open(windowId: number): Promise<{ streamId: string }> {
      const [tab] = await chrome.tabs.query({ windowId, active: true });
      if (tab?.id === undefined) throw new Error("No tab in that window");
      await offscreenDocument();
      return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }) };
    },
    /** The offscreen document exists (to ask what it can encode). */
    ready: offscreenDocument,
  },
});
