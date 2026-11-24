import { expect, it } from "vitest";
import type { BaseWindow, Session, WebContentsView } from "electron";
import { EmbeddedPage } from "./page.ts";

/**
 * The parts of Electron an `EmbeddedPage` touches on the placement, parking and zoom paths:
 * the view's box and visibility, its web contents' zoom and CDP, and the window it attaches to.
 * CDP commands are recorded rather than run, as there is no Chromium here.
 */
class FakeContents {
  zoom = 1;
  muted = false;
  destroyed = false;
  backgroundThrottled = false;
  readonly commands: { method: string; params: Record<string, unknown> }[] = [];
  private listeners = new Map<string, ((...args: never[]) => void)[]>();
  readonly session = {};
  readonly debugger = {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: () => {
      this.debugger.attached = true;
    },
    detach: () => {
      this.debugger.attached = false;
    },
    on: (_event: string, _listener: (...args: never[]) => void) => this.debugger,
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      this.commands.push({ method, params });
      return {};
    },
  };
  readonly ipc = {
    on: (_event: string, _listener: (...args: never[]) => void) => {},
  };

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  /** Fire what Electron would, for a page whose handlers a test needs. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }

  getURL(): string {
    return "about:blank";
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getZoomFactor(): number {
    return this.zoom;
  }
  setZoomFactor(zoom: number): void {
    this.zoom = zoom;
  }
  isAudioMuted(): boolean {
    return this.muted;
  }
  setAudioMuted(muted: boolean): void {
    this.muted = muted;
  }
  isCurrentlyAudible(): boolean {
    return false;
  }
  setBackgroundThrottling(throttled: boolean): void {
    this.backgroundThrottled = throttled;
  }
  setWindowOpenHandler(): this {
    return this;
  }
  close(): void {
    this.destroyed = true;
  }
}

/** A view whose box is in window DIPs, as Electron's. */
class FakeView {
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  readonly webContents = new FakeContents();
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds };
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

class FakeWindow {
  destroyed = false;
  readonly children: unknown[] = [];
  readonly contentView = {
    addChildView: (view: unknown) => {
      this.children.push(view);
    },
    removeChildView: (view: unknown) => {
      const at = this.children.indexOf(view);
      if (at >= 0) this.children.splice(at, 1);
    },
  };
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function harness() {
  const view = new FakeView();
  const window = new FakeWindow();
  const parks: { width: number; height: number }[] = [];
  const events: { method: string; params: unknown }[] = [];
  const page = new EmbeddedPage({
    view: view as unknown as WebContentsView,
    session: {} as unknown as Session,
    released: undefined,
    window: window as unknown as BaseWindow,
    park: (size) => {
      parks.push(size);
      return window as unknown as BaseWindow;
    },
    platform: process.platform,
    log: () => {},
    forward: () => {},
    forget: () => {},
    confirmLeave: () => true,
  });
  page.onEvent((method, params) => events.push({ method, params }));
  const viewports = (): unknown[] =>
    events.filter((event) => event.method === "ace.viewport").map((event) => event.params);
  return { page, view, window, parks, events, viewports };
}

it("a parked page reports its new CSS size when its zoom changes", async () => {
  const { page, view, window, viewports } = harness();
  page.setAgentControl(true);
  const bounds = { x: 0, y: 0, width: 1280, height: 800 };
  page.place({ window: window as unknown as BaseWindow, bounds, visible: true, zoom: 1 });
  await page.placementReady();
  expect(viewports().at(-1)).toEqual({ width: 1280, height: 800 });
  // The panel stops showing the tab: it keeps its box, laid out at the zoom it was placed at.
  page.place({ window: window as unknown as BaseWindow, bounds, visible: false });
  await page.cdp("ace.zoom", { factor: 2 });
  expect(viewports().at(-1)).toEqual({ width: 640, height: 400 });
  expect(view.bounds).toEqual(bounds);
  await page.close();
});
