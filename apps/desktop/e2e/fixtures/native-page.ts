import type { ElectronApplication, Page } from "playwright-core";
import { z } from "zod";

/** The desktop's native view of `url`, read from Electron's main process. */
export function nativePage(app: ElectronApplication, page: Page, url: string) {
  /** Runs `expression` in the native page itself. */
  const read = (expression: string) =>
    app.evaluate(
      ({ webContents }, args) => {
        const c = webContents.getAllWebContents().find((entry) => entry.getURL() === args.url);
        if (!c) throw new Error("Fixture native page missing");
        return c.executeJavaScript(args.expression);
      },
      { url, expression },
    );
  /** The view's WebContents id: the same id means the same live page, never reloaded. */
  const contentsId = () =>
    app.evaluate(
      ({ webContents }, address) =>
        webContents.getAllWebContents().find((entry) => entry.getURL() === address)?.id,
      url,
    );
  /** Where the panel's page area is, and where (and whether) the app window shows the view. */
  const geometry = async () => {
    const box = await page.locator("[data-browser-page]").evaluateAll((elements) => {
      const element = elements[0];
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const native = await app.evaluate(({ BrowserWindow, webContents }, address) => {
      const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === address);
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
        (v) => "webContents" in v && v.webContents === contents,
      );
      // A view outside the app window (parked while an agent drives it) is not seen.
      return view
        ? { bounds: view.getBounds(), visible: view.getVisible() }
        : { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false };
    }, url);
    return { box, native };
  };
  /** The native view exactly covers the panel's page area and is visible. */
  const placed = async () => {
    const { box, native } = await geometry();
    return (
      !!box &&
      native.visible &&
      (["x", "y", "width", "height"] as const).every(
        (key) => Math.abs(native.bounds[key] - box[key]) < 2,
      )
    );
  };
  /** A person's own click (OS-level input to the view), at an element's centre. */
  const personClicks = async (selector: string) => {
    const point = z
      .object({ x: z.number(), y: z.number() })
      .parse(
        await read(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        ),
      );
    await app.evaluate(
      ({ webContents }, args) => {
        const c = webContents.getAllWebContents().find((entry) => entry.getURL() === args.url);
        if (!c) throw new Error("Native fixture missing");
        c.focus();
        setTimeout(() => {
          for (const type of ["mouseDown", "mouseUp"] as const)
            c.sendInputEvent({ type, ...args.point, button: "left", clickCount: 1 });
        }, 0);
      },
      { url, point },
    );
  };
  return { read, contentsId, geometry, placed, personClicks };
}
