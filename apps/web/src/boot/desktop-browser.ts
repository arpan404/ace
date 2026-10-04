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
  visible: boolean;
}

export interface DesktopBrowserViews {
  place(placement: NativeViewPlacement): Promise<void>;
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
  return {
    place: async (placement) => {
      await Promise.resolve(Reflect.apply(place, browser, [placement]));
    },
  };
}
