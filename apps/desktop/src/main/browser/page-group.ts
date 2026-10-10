import { z } from "zod";
import type { ViewPage } from "./backend.ts";
import type { EmbeddedPage } from "./page.ts";
import type { BaseWindow } from "electron";
import type { NativeDevice, Rect } from "./placement.ts";

const TabCommand = z.object({ tabId: z.string().min(1).max(256) });
const CdpCommand = TabCommand.extend({
  method: z.string().min(1).max(256),
  params: z.record(z.string(), z.unknown()).optional(),
});
interface Tab {
  id: string;
  page: EmbeddedPage;
  title: string;
  url: string;
  stop(): void;
  blocked(): void;
}
/** A thread's native tabs share a partition and a lease, with one placed page. */
export class EmbeddedPageGroup implements ViewPage {
  private tabs = new Map<string, Tab>();
  private active = "";
  private sequence = 0;
  private opening = 0;
  private input = false;
  private agent = true;
  private closed = false;
  private closing: Promise<void> | undefined;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private blocked = new Set<() => void>();
  private target: {
    window: BaseWindow | undefined;
    bounds: Rect | undefined;
    visible: boolean;
    zoom?: number;
    device?: NativeDevice | undefined;
  } = { window: undefined, bounds: undefined, visible: false };
  constructor(
    privateCreate: (id: string) => Promise<EmbeddedPage>,
    privateClose: () => Promise<void>,
  ) {
    this.create = privateCreate;
    this.finish = privateClose;
  }
  private create: (id: string) => Promise<EmbeddedPage>;
  private finish: () => Promise<void>;
  private current(): Tab {
    const tab = this.tabs.get(this.active);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }
  snapshot() {
    return {
      activeTabId: this.active,
      tabs: [...this.tabs.values()].map((tab) => ({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        viewport: tab.page.viewport(),
      })),
    };
  }
  private emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener(method, params);
  }
  private changed() {
    this.emit("ace.tabs.changed", this.snapshot());
  }
  async openTab(): Promise<string> {
    if (this.closed || this.tabs.size + this.opening >= 8) throw new Error("Browser tab limit");
    this.opening++;
    const id = `native-tab-${++this.sequence}`;
    try {
      const page = await this.create(id);
      if (this.closed) {
        await page.close();
        throw new Error("Browser closed");
      }
      const tab: Tab = { id, page, title: "", url: page.url(), stop: () => {}, blocked: () => {} };
      this.tabs.set(id, tab);
      if (!this.active) this.active = id;
      tab.stop = page.onEvent((method, params) => {
        if (method === "Page.screencastFrame") {
          if (id === this.active) {
            const frame = z.record(z.string(), z.unknown()).parse(params);
            this.emit(method, { ...frame, aceTabId: id });
          } else {
            const frame = z.object({ sessionId: z.number().int() }).safeParse(params);
            if (frame.success) void page.cdp("Page.screencastFrameAck", frame.data).catch(() => {});
          }
          return;
        }
        if (method === "Inspector.detached") {
          if (!this.closed) void this.remove(id).catch(() => {});
          return;
        }
        if (method === "ace.permissionDenied" || method === "ace.downloadDenied") {
          this.emit(method, params);
          return;
        }
        if (method === "ace.popupRequested") {
          this.emit(method, {
            tabId: id,
            ...z.object({ url: z.string().max(8192) }).parse(params),
          });
          return;
        }
        if (method === "ace.title") {
          tab.title = z.object({ title: z.string().max(1024) }).parse(params).title;
          this.changed();
          return;
        }
        if (method === "Page.frameNavigated") {
          const nav = z
            .object({
              frame: z.object({ url: z.string().max(8192), parentId: z.string().optional() }),
            })
            .safeParse(params);
          if (nav.success && !nav.data.frame.parentId) {
            tab.url = nav.data.frame.url;
            this.changed();
          }
        }
        this.emit("ace.tabs.event", { tabId: id, method, params });
      });
      tab.blocked = page.onBlockedInput(() => {
        if (id === this.active) for (const notify of this.blocked) notify();
      });
      this.apply();
      this.changed();
      return id;
    } finally {
      this.opening--;
    }
  }
  private apply() {
    for (const [id, tab] of this.tabs) {
      tab.page.place({ ...this.target, visible: this.target.visible && id === this.active });
      tab.page.setNativeInput(this.input && id === this.active);
      tab.page.setAgentControl(this.agent);
    }
  }
  async placementReady(): Promise<void> {
    await this.tabs.get(this.active)?.page.placementReady();
  }
  isShown(): boolean {
    return this.tabs.get(this.active)?.page.isShown() ?? false;
  }
  place(target: typeof this.target) {
    this.target = target;
    this.apply();
  }
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "ace.tabs.list") return this.snapshot();
    if (method === "ace.tabs.open") {
      await this.openTab();
      return this.snapshot();
    }
    if (method === "ace.tabs.switch") {
      const { tabId } = TabCommand.parse(params);
      if (!this.tabs.has(tabId)) throw new Error("Browser tab unavailable");
      this.active = tabId;
      this.apply();
      this.changed();
      return this.snapshot();
    }
    if (method === "ace.tabs.close") {
      const { tabId } = TabCommand.parse(params);
      if (this.tabs.size === 1) throw new Error("Close the browser to close its last tab");
      await this.remove(tabId);
      return this.snapshot();
    }
    if (method === "ace.tabs.cdp") {
      const command = CdpCommand.parse(params);
      const tab = this.tabs.get(command.tabId);
      if (!tab) throw new Error("Browser tab unavailable");
      return tab.page.cdp(command.method, command.params);
    }
    return this.current().page.cdp(method, params);
  }
  private async remove(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    this.tabs.delete(id);
    tab.stop();
    tab.blocked();
    await tab.page.close();
    if (this.active === id) this.active = this.tabs.keys().next().value ?? "";
    this.apply();
    this.changed();
    if (!this.tabs.size && !this.closed)
      this.emit("Inspector.detached", { reason: "All browser tabs closed" });
  }
  onEvent(listener: (method: string, params: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onBlockedInput(listener: () => void) {
    this.blocked.add(listener);
    return () => this.blocked.delete(listener);
  }
  navigate(url: string, timeout: number) {
    return this.current().page.navigate(url, timeout);
  }
  press(key: string) {
    return this.current().page.press(key);
  }
  resize(width: number, height: number) {
    return this.current().page.resize(width, height);
  }
  setNativeInput(enabled: boolean) {
    this.input = enabled;
    this.apply();
  }
  setAgentControl(agent: boolean) {
    this.agent = agent;
    this.apply();
  }
  url() {
    return this.current().url;
  }
  close(): Promise<void> {
    return (this.closing ??= this.destroy());
  }
  private async destroy() {
    this.closed = true;
    await Promise.all(
      [...this.tabs.values()].map(async (tab) => {
        tab.stop();
        tab.blocked();
        await tab.page.close();
      }),
    );
    this.tabs.clear();
    this.listeners.clear();
    await this.finish();
  }
}
