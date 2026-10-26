import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { showWhenReady } from "./show-when-ready.ts";

/** A hidden window and its page, driven by the test, and the timers it was given. */
function setup(graceMs: number | undefined) {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: new EventEmitter(),
  });
  const pending: { delayMs: number; callback: () => void; cancelled: boolean }[] = [];
  const timers = {
    set(delayMs: number, callback: () => void) {
      const entry = { delayMs, callback, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  let shows = 0;
  showWhenReady(window, () => shows++, { timers, graceMs });
  const elapse = () => {
    for (const entry of pending.splice(0)) if (!entry.cancelled) entry.callback();
  };
  return { window, elapse, shows: () => shows };
}

it("shows the window once its page has painted", () => {
  const { window, shows } = setup(1000);
  window.emit("ready-to-show");
  expect(shows()).toBe(1);
});

it("on Linux, a page that never reports a paint still shows once it has loaded and the grace passed", () => {
  const { window, elapse, shows } = setup(1000);
  window.webContents.emit("did-finish-load");
  expect(shows()).toBe(0);
  elapse();
  expect(shows()).toBe(1);
});

it("a paint report and the grace timer show the window only once", () => {
  const { window, elapse, shows } = setup(1000);
  window.webContents.emit("did-finish-load");
  window.emit("ready-to-show");
  elapse();
  expect(shows()).toBe(1);
});

it("without a grace (macOS, Windows) the window waits for its paint", () => {
  const { window, elapse, shows } = setup(undefined);
  window.webContents.emit("did-finish-load");
  elapse();
  expect(shows()).toBe(0);
});

it("a window closed while it waited is never shown", () => {
  const { window, elapse, shows } = setup(1000);
  window.webContents.emit("did-finish-load");
  window.destroyed = true;
  window.emit("closed");
  elapse();
  window.emit("ready-to-show");
  expect(shows()).toBe(0);
});
