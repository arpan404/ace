import type { BrowserBackendPage, BrowserCdp } from "./backend.ts";

/**
 * The page a command acts through while its caller's gate holds it to a place (`expect`, ADR
 * 0171 amendment 3). Every input dispatch passes here: the backend's input primitives and the
 * CDP methods that send input or move the page, in the page and in each of its frames. Each
 * re-checks the place first, so no command, loop or repetition can send input after the tab
 * moved on. Reads pass untouched.
 */
export function guardedPage(page: BrowserBackendPage, check: () => void): BrowserBackendPage {
  const cdp = guardedCdp(page.cdp, check);
  return new Proxy(page, {
    get(target, property) {
      if (property === "cdp") return cdp;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "frames")
        return async () => {
          const frames: Awaited<ReturnType<NonNullable<BrowserBackendPage["frames"]>>> =
            await value.call(target);
          const guarded: typeof frames = [];
          for (const frame of frames) {
            const each: (typeof frames)[number] = {
              frameId: frame.frameId,
              cdp: guardedCdp(frame.cdp, check),
            };
            if (frame.parentId !== undefined) each.parentId = frame.parentId;
            guarded.push(each);
          }
          return guarded;
        };
      if (typeof property === "string" && pagePrimitives.has(property))
        return (...args: unknown[]) => {
          check();
          return value.apply(target, args);
        };
      return value.bind(target);
    },
  });
}

/** The backend's own input primitives. */
const pagePrimitives: ReadonlySet<string> = new Set([
  "click",
  "insertText",
  "press",
  "wheel",
  "navigate",
]);

/** CDP methods outside `Input.*` that change what the page holds or where it is. */
const moves: ReadonlySet<string> = new Set([
  "DOM.setFileInputFiles",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload",
]);

/**
 * The end of a gesture already begun: letting go of a pressed button, key or touch is never
 * refused, so a place that changed mid-gesture never leaves one held down.
 */
const endings: ReadonlySet<unknown> = new Set([
  "mouseReleased",
  "keyUp",
  "touchEnd",
  "touchCancel",
]);

/** Whether a CDP call sends the page input or moves it, so the place is checked before it. */
export function dispatchesInput(method: string, params?: Record<string, unknown>): boolean {
  if (method.startsWith("Input.")) return !endings.has(params?.["type"]);
  return moves.has(method);
}

export function guardedCdp(cdp: BrowserCdp, check: () => void): BrowserCdp {
  return new Proxy(cdp, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "send")
        return (method: string, params?: Record<string, unknown>) => {
          if (dispatchesInput(method, params)) check();
          return value.call(target, method, params);
        };
      return value.bind(target);
    },
  });
}
