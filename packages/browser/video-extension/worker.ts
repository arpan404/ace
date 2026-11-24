/*
 * The video extension's service worker (ADR 0088). The daemon calls `aceVideo.open` over CDP
 * (`Runtime.evaluate` on this worker) to get a capture id for the tab shown in a window; the
 * offscreen document opens and encodes it. Nothing else runs here but the tab's sound: each
 * change of whether the tab plays or is muted goes to the daemon through `aceVideoTab`.
 */

interface ChromeTab {
  id?: number;
  windowId?: number;
  /** The tab has played sound in the last few seconds. */
  audible?: boolean;
  mutedInfo?: { muted: boolean };
}
interface TabChange {
  audible?: boolean;
  mutedInfo?: { muted: boolean };
}
interface VideoChrome {
  tabs: {
    query(query: { windowId: number; active: boolean }): Promise<ChromeTab[]>;
    update(tabId: number, properties: { muted: boolean }): Promise<ChromeTab>;
    onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: TabChange, tab: ChromeTab) => void,
      ): void;
    };
  };
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

/** The active tab of `windowId`, which is the tab ace's viewer shows there. */
async function activeTab(windowId: number): Promise<ChromeTab> {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (!tab) throw new Error("No tab in that window");
  return tab;
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.audible === undefined && changeInfo.mutedInfo === undefined) return;
  // The daemon's CDP binding (`chrome-video.ts`), as JSON; without one, nobody listens.
  const send: unknown = Reflect.get(globalThis, "aceVideoTab");
  if (typeof send !== "function") return;
  Reflect.apply(send, globalThis, [
    JSON.stringify({
      windowId: tab.windowId,
      audible: tab.audible === true,
      muted: tab.mutedInfo?.muted === true,
    }),
  ]);
});

Object.assign(globalThis, {
  aceVideo: {
    /** The offscreen document exists and `streamId` captures the tab shown in `windowId`. */
    async open(windowId: number): Promise<{ streamId: string }> {
      const tab = await activeTab(windowId);
      if (tab.id === undefined) throw new Error("No tab in that window");
      await offscreenDocument();
      return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }) };
    },
    /** Whether the tab shown in `windowId` plays sound, and whether it is muted. */
    async tabAudio(windowId: number): Promise<{ audible: boolean; muted: boolean }> {
      const tab = await activeTab(windowId);
      return { audible: tab.audible === true, muted: tab.mutedInfo?.muted === true };
    },
    /** Turns the sound of the tab shown in `windowId` off or on. */
    async mute(windowId: number, muted: boolean): Promise<void> {
      const tab = await activeTab(windowId);
      if (tab.id === undefined) throw new Error("No tab in that window");
      await chrome.tabs.update(tab.id, { muted });
    },
    /** The offscreen document exists (to ask what it can encode). */
    ready: offscreenDocument,
  },
});
