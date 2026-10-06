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
  bounds: PageBox;
  device?:
    | {
        width: number;
        height: number;
        mobile?: boolean | undefined;
        deviceScaleFactor?: number | undefined;
      }
    | undefined;
  dpr?: number | undefined;
  visible: boolean;
  /**
   * The daemon connection through which this page holds the thread's page, as its take-control
   * reply named it. The desktop lets the person's clicks and keys through only while the
   * daemon's lease is that connection's.
   */
  owner?: string | undefined;
}

export type BrowserAccelerator =
  | "CmdOrCtrl+L"
  | "CmdOrCtrl+F"
  | "CmdOrCtrl+R"
  | "CmdOrCtrl+["
  | "CmdOrCtrl+]";

export interface DesktopBrowserViews {
  onShortcut(listener: (threadId: string, accelerator: BrowserAccelerator) => void): () => void;
  place(placement: NativeViewPlacement): Promise<void>;
  /**
   * The person clicked or typed on a page they don't control; take control for them. Returns
   * an unsubscribe.
   */
  onWantsControl(listener: (threadId: string) => void): () => void;
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
  const onWants =
    typeof browser === "object" && browser !== null && "onWantsControl" in browser
      ? browser.onWantsControl
      : undefined;
  const onShortcut =
    typeof browser === "object" && browser !== null && "onShortcut" in browser
      ? browser.onShortcut
      : undefined;
  return {
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
          const accelerator = event.accelerator;
          if (
            accelerator === "CmdOrCtrl+L" ||
            accelerator === "CmdOrCtrl+F" ||
            accelerator === "CmdOrCtrl+R" ||
            accelerator === "CmdOrCtrl+[" ||
            accelerator === "CmdOrCtrl+]"
          )
            listener(event.threadId, accelerator);
        },
      ]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    place: async (placement) => {
      await Promise.resolve(Reflect.apply(place, browser, [placement]));
    },
    onWantsControl: (listener) => {
      if (typeof onWants !== "function") return () => {};
      const stop: unknown = Reflect.apply(onWants, browser, [
        (event: unknown) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "threadId" in event &&
            typeof event.threadId === "string"
          )
            listener(event.threadId);
        },
      ]);
      return () => {
        if (typeof stop === "function") stop();
      };
    },
  };
}
