/*
 * The video extension's service worker (ADR 0088). The daemon calls `aceVideo.open` over CDP
 * (`Runtime.evaluate` on this worker) to get a capture id for a Chrome tab; the offscreen
 * document opens and encodes it. Nothing else runs here but the tab's sound: each change of
 * whether the tab plays or is muted goes to the daemon through `aceVideoTab`.
 *
 * Everything is keyed by Chrome tab, never by window: a named `window.open` without features
 * opens a tab in its opener's window, and the two tabs must keep their own sound.
 */

interface ChromeTab {
  id?: number;
  /** The tab has played sound in the last few seconds. */
  audible?: boolean;
  mutedInfo?: { muted: boolean };
}
interface TabChange {
  audible?: boolean;
  mutedInfo?: { muted: boolean };
}
interface DebugTarget {
  id: string;
  tabId?: number;
}
interface VideoChrome {
  tabs: {
    get(tabId: number): Promise<ChromeTab>;
    update(tabId: number, properties: { muted: boolean }): Promise<ChromeTab>;
    onUpdated: {
      addListener(listener: (tabId: number, changeInfo: TabChange, tab: ChromeTab) => void): void;
    };
  };
  tabCapture: { getMediaStreamId(options: { targetTabId: number }): Promise<string> };
  /** Only `getTargets`: a CDP target id is resolved to its Chrome tab (never attached). */
  debugger: { getTargets(): Promise<DebugTarget[]> };
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.audible === undefined && changeInfo.mutedInfo === undefined) return;
  // The daemon's CDP binding (`chrome-video.ts`), as JSON; without one, nobody listens.
  const send: unknown = Reflect.get(globalThis, "aceVideoTab");
  if (typeof send !== "function") return;
  Reflect.apply(send, globalThis, [
    JSON.stringify({
      tabId,
      audible: tab.audible === true,
      muted: tab.mutedInfo?.muted === true,
    }),
  ]);
});

Object.assign(globalThis, {
  aceVideo: {
    /** The Chrome tab id of a CDP target: the daemon knows a page by its CDP target. */
    async tabFor(targetId: string): Promise<number> {
      const target = (await chrome.debugger.getTargets()).find(
        (candidate) => candidate.id === targetId,
      );
      if (target?.tabId === undefined) throw new Error("No tab for that target");
      return target.tabId;
    },
    /** The offscreen document exists and `streamId` captures `targetTabId`. */
    async open(targetTabId: number): Promise<{ streamId: string }> {
      await offscreenDocument();
      return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId }) };
    },
    /** Whether the tab plays sound, and whether it is muted. */
    async tabAudio(targetTabId: number): Promise<{ audible: boolean; muted: boolean }> {
      const tab = await chrome.tabs.get(targetTabId);
      return { audible: tab.audible === true, muted: tab.mutedInfo?.muted === true };
    },
    /** Turns the tab's sound off or on. */
    async mute(targetTabId: number, muted: boolean): Promise<void> {
      await chrome.tabs.update(targetTabId, { muted });
    },
    /** The offscreen document exists (to ask what it can encode). */
    ready: offscreenDocument,
  },
});
