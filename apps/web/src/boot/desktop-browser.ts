/** A box in this page's CSS pixels, relative to the window's content. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the desktop app draws a thread's embedded browser view over this page. */
export interface NativeViewPlacement {
  threadId: string;
  /** One tab of the thread (split view); omitted: the tab the thread shows. */
  tabId?: string | undefined;
  bounds: PageBox;
  device?:
    | {
        width: number;
        height: number;
        mobile?: boolean | undefined;
        deviceScaleFactor?: number | undefined;
      }
    | undefined;
  visible: boolean;
}

export type BrowserAccelerator =
  | "CmdOrCtrl+T"
  | "CmdOrCtrl+L"
  | "CmdOrCtrl+F"
  | "CmdOrCtrl+R"
  | "CmdOrCtrl+["
  | "CmdOrCtrl+]"
  | "CmdOrCtrl+="
  | "CmdOrCtrl+-"
  | "CmdOrCtrl+0";

const accelerators: readonly BrowserAccelerator[] = [
  "CmdOrCtrl+T",
  "CmdOrCtrl+L",
  "CmdOrCtrl+F",
  "CmdOrCtrl+R",
  "CmdOrCtrl+[",
  "CmdOrCtrl+]",
  "CmdOrCtrl+=",
  "CmdOrCtrl+-",
  "CmdOrCtrl+0",
];

/** A native page's context menu pick that the app carries out (see the desktop's contract). */
export type BrowserContextAction =
  | { action: "back" | "forward" | "reload" | "annotate" | "viewSource" }
  | { action: "openTab"; url: string };

export interface DesktopBrowserViews {
  onVisibility(
    listener: (threadId: string, visible: boolean, tabId: string | undefined) => void,
  ): () => void;
  onShortcut(listener: (threadId: string, accelerator: BrowserAccelerator) => void): () => void;
  place(placement: NativeViewPlacement): Promise<"shown" | "hidden" | "unavailable" | "superseded">;
  /**
   * The thread's shown view as a still picture (a `data:` URL), to hold in its place while a
   * menu covers it; undefined when nothing shows it or the app can't capture.
   */
  snapshot(threadId: string, tabId?: string): Promise<string | undefined>;
  /**
   * This page focused one of its own fields: the OS focus leaves any native view now, and keys
   * typed there since a native ⌘L or ⌘F land in the field.
   */
  focusApp(): void;
  /**
   * The thread's shown native tab: the system print dialog, or its developer tools (at a point
   * of the page when `inspect` is given). False when this window has no native view of it.
   */
  page(
    threadId: string,
    action: "print" | "devtools",
    inspect?: { x: number; y: number },
  ): Promise<boolean>;
  /** The person picked an item in a native page's context menu that the app carries out. */
  onContext(listener: (threadId: string, action: BrowserContextAction) => void): () => void;
}

/**
 * The desktop app's embedded browser views (`window.ace.browser.place`). In the desktop app a
 * thread's page runs in a native view that must be drawn where its Browser tab is: a view
 * nobody placed stays hidden and paints nothing. A browser has no bridge: undefined.
 */
export function desktopBrowserViews(scope: object = globalThis): DesktopBrowserViews | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const browser =
    typeof ace === "object" && ace !== null && "browser" in ace
      ? (ace.browser as unknown)
      : undefined;
  const place =
    typeof browser === "object" && browser !== null && "place" in browser
      ? browser.place
      : undefined;
  if (typeof place !== "function") return undefined;
  const snapshot =
    typeof browser === "object" && browser !== null && "snapshot" in browser
      ? browser.snapshot
      : undefined;
  const onShortcut =
    typeof browser === "object" && browser !== null && "onShortcut" in browser
      ? browser.onShortcut
      : undefined;
  const onVisibility =
    typeof browser === "object" && browser !== null && "onVisibility" in browser
      ? browser.onVisibility
      : undefined;
  const focusApp =
    typeof browser === "object" && browser !== null && "focusApp" in browser
      ? browser.focusApp
      : undefined;
  const page =
    typeof browser === "object" && browser !== null && "page" in browser ? browser.page : undefined;
  const onContext =
    typeof browser === "object" && browser !== null && "onContext" in browser
      ? browser.onContext
      : undefined;
  return {
    focusApp: () => {
      if (typeof focusApp !== "function") return;
      void Promise.resolve(Reflect.apply(focusApp, browser, [])).catch(() => {});
    },
    onVisibility: (listener) => {
      if (typeof onVisibility !== "function") return () => {};
      const stop: unknown = Reflect.apply(onVisibility, browser, [
        (event: unknown) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "threadId" in event &&
            typeof event.threadId === "string" &&
            "visible" in event &&
            typeof event.visible === "boolean"
          )
            listener(
              event.threadId,
              event.visible,
              "tabId" in event && typeof event.tabId === "string" ? event.tabId : undefined,
            );
        },
      ]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    onShortcut: (listener) => {
      if (typeof onShortcut !== "function") return () => {};
      const stop: unknown = Reflect.apply(onShortcut, browser, [
        (event: unknown) => {
          if (
            typeof event !== "object" ||
            event === null ||
            !("threadId" in event) ||
            typeof event.threadId !== "string" ||
            !("accelerator" in event)
          )
            return;
          const accelerator = accelerators.find((each) => each === event.accelerator);
          if (accelerator) listener(event.threadId, accelerator);
        },
      ]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    page: async (threadId, action, inspect) => {
      if (typeof page !== "function") return false;
      const done: unknown = await Promise.resolve(
        Reflect.apply(page, browser, [{ threadId, action, ...(inspect ? { inspect } : {}) }]),
      ).catch(() => false);
      return done === true;
    },
    onContext: (listener) => {
      if (typeof onContext !== "function") return () => {};
      const stop: unknown = Reflect.apply(onContext, browser, [
        (event: unknown) => {
          const picked = contextAction(event);
          if (picked) listener(picked.threadId, picked.action);
        },
      ]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    place: async (placement) => {
      const receipt: unknown = await Promise.resolve(Reflect.apply(place, browser, [placement]));
      if (receipt === "shown" || receipt === "hidden" || receipt === "superseded") return receipt;
      return receipt === true ? "shown" : "unavailable";
    },
    snapshot: async (threadId, tabId) => {
      if (typeof snapshot !== "function") return undefined;
      const picture: unknown = await Promise.resolve(
        Reflect.apply(snapshot, browser, [{ threadId, ...(tabId ? { tabId } : {}) }]),
      ).catch(() => undefined);
      return typeof picture === "string" && picture.startsWith("data:image/") ? picture : undefined;
    },
  };
}

/** A `browser.context` event from the desktop, checked field by field. */
function contextAction(
  event: unknown,
): { threadId: string; action: BrowserContextAction } | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const threadId = Reflect.get(event, "threadId");
  const action = Reflect.get(event, "action");
  const url = Reflect.get(event, "url");
  if (typeof threadId !== "string") return undefined;
  if (action === "openTab")
    return typeof url === "string" && /^https?:\/\//i.test(url)
      ? { threadId, action: { action, url } }
      : undefined;
  if (
    action === "back" ||
    action === "forward" ||
    action === "reload" ||
    action === "annotate" ||
    action === "viewSource"
  )
    return { threadId, action: { action } };
  return undefined;
}
