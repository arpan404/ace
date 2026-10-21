import { z } from "zod";
import type { ViewPage } from "./backend.ts";
import type { EmbeddedPage } from "./page.ts";
import type { BaseWindow } from "electron";
import type { NativeDevice, Rect } from "./placement.ts";

/** Live native tabs one thread may hold (ADR 0083's per-thread limit). */
export const nativeTabLimit = 16;

const TabCommand = z.object({ tabId: z.string().min(1).max(256) });
const CdpCommand = TabCommand.extend({
  method: z.string().min(1).max(256),
  params: z.record(z.string(), z.unknown()).optional(),
});
/**
 * `select` makes the new tab the one the panel shows; by default it opens in the background.
 * `tabId` asks for the tab's id: the daemon restores a thread's tabs with the ids they had.
 */
const OpenCommand = z
  .object({ select: z.boolean().optional(), tabId: z.string().min(1).max(256).optional() })
  .optional();
const ResizeCommand = TabCommand.extend({
  width: z.number().int().min(100).max(4096),
  height: z.number().int().min(100).max(4096),
});
type GroupPage = Pick<
  EmbeddedPage,
  | "cdp"
  | "onEvent"
  | "onHumanInput"
  | "navigate"
  | "press"
  | "resize"
  | "setNativeInput"
  | "setAgentControl"
  | "url"
  | "close"
  | "viewport"
  | "place"
  | "placementReady"
  | "isShown"
  | "picture"
> &
  Partial<
    Pick<
      EmbeddedPage,
      "orphan" | "readopt" | "evacuate" | "devtools" | "print" | "lastDriven" | "setPicture"
    >
  >;

interface Target {
  window: BaseWindow | undefined;
  bounds: Rect | undefined;
  visible: boolean;
  /** Hidden only while the app's menu covers it (`BrowserPlacement.covered`). */
  covered?: boolean;
  /** Drawn as picture-in-picture (`BrowserPlacement.picture`). */
  picture?: boolean;
  zoom?: number;
  device?: NativeDevice | undefined;
}

interface Tab {
  id: string;
  page: GroupPage;
  title: string;
  url: string;
  mainFrame?: string;
  stop(): void;
  stopInput(): void;
}

/**
 * A thread's native tabs: one `WebContentsView` each, sharing the thread's partition. Only the
 * selected tab is placed in the Browser panel and takes the person's input; the others stay
 * alive unseen, and render in the parking window while an agent drives them (see `throttle.ts`).
 * Commands without a tab go to the selected tab; `ace.tabs.*` commands address any tab.
 */
export class EmbeddedPageGroup implements ViewPage {
  private tabs = new Map<string, Tab>();
  private active = "";
  private sequence = 0;
  private opening = 0;
  /** Ids of tabs being created, so two opens never share one. */
  private claimed = new Set<string>();
  private input = false;
  private agent = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private listeners = new Set<(method: string, params: unknown) => void>();
  private humanInput = new Set<(tabId?: string) => void>();
  private target: Target = { window: undefined, bounds: undefined, visible: false };
  /** Tabs placed by id beside the shown one (split view), each where its half of the panel is. */
  private pinned = new Map<string, Target>();
  private create: (id: string) => Promise<GroupPage>;
  private finish: () => Promise<void>;

  constructor(create: (id: string) => Promise<GroupPage>, finish: () => Promise<void>) {
    this.create = create;
    this.finish = finish;
  }

  private current(): Tab {
    const tab = this.tabs.get(this.active);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }

  private tab(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
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

  /** The requested id when it is free, else the next generated one. */
  private nextId(requested: string | undefined): string {
    const taken = (id: string) => this.tabs.has(id) || this.claimed.has(id);
    if (requested !== undefined && !taken(requested)) {
      // Generated ids never collide with a restored one later.
      const generated = /^native-tab-(\d+)$/.exec(requested);
      if (generated) this.sequence = Math.max(this.sequence, Number(generated[1]));
      return requested;
    }
    let id = `native-tab-${++this.sequence}`;
    while (taken(id)) id = `native-tab-${++this.sequence}`;
    return id;
  }

  /** A new tab, in the background unless `select` or it is the thread's first. */
  async openTab(
    options: { select?: boolean | undefined; tabId?: string | undefined } = {},
  ): Promise<string> {
    if (this.closed) throw new Error("Browser closed");
    if (this.tabs.size + this.opening >= nativeTabLimit) throw new Error("Browser tab limit");
    this.opening++;
    const id = this.nextId(options.tabId);
    this.claimed.add(id);
    try {
      const page = await this.create(id);
      if (this.closed) {
        await page.close();
        throw new Error("Browser closed");
      }
      const tab: Tab = {
        id,
        page,
        title: "",
        url: page.url(),
        stop: () => {},
        stopInput: () => {},
      };
      this.tabs.set(id, tab);
      if (!this.active || options.select) this.active = id;
      tab.stop = page.onEvent((method, params) => this.tabEvent(tab, method, params));
      tab.stopInput = page.onHumanInput(() => {
        for (const notify of this.humanInput) notify(id);
      });
      this.apply();
      this.changed();
      return id;
    } finally {
      this.opening--;
      this.claimed.delete(id);
    }
  }

  private tabEvent(tab: Tab, method: string, params: unknown): void {
    const id = tab.id;
    if (method === "Page.screencastFrame") {
      if (id === this.active) {
        const frame = z.record(z.string(), z.unknown()).parse(params);
        this.emit(method, { ...frame, aceTabId: id });
      } else {
        const frame = z.object({ sessionId: z.number().int() }).safeParse(params);
        if (frame.success) void tab.page.cdp("Page.screencastFrameAck", frame.data).catch(() => {});
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
      this.emit(method, { tabId: id, ...z.object({ url: z.string().max(8192) }).parse(params) });
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
          frame: z.object({
            id: z.string(),
            url: z.string().max(8192),
            parentId: z.string().optional(),
          }),
        })
        .safeParse(params);
      if (nav.success && !nav.data.frame.parentId) {
        tab.mainFrame = nav.data.frame.id;
        tab.url = nav.data.frame.url;
        this.changed();
      }
    }
    if (method === "Page.navigatedWithinDocument") {
      const nav = z.object({ frameId: z.string(), url: z.string().max(8192) }).safeParse(params);
      if (nav.success && nav.data.frameId === tab.mainFrame) {
        tab.url = nav.data.url;
        this.changed();
      }
    }
    this.emit("ace.tabs.event", { tabId: id, method, params });
  }

  /**
   * The selected tab is placed where the panel shows the thread's page, and a tab placed by id
   * (split view) where its half is; those take the person's input. Whether an agent uses the
   * selected tab comes from the daemon (the shown tab's, ADR 0085). The person cannot reach an
   * unseen tab, so it is always treated as the agents': it renders while driven and intercepts
   * its file choosers.
   */
  private apply() {
    for (const [id, tab] of this.tabs) {
      const pin = this.pinned.get(id);
      const target = pin?.visible ? pin : id === this.active ? this.target : (pin ?? this.target);
      const here = target === pin || id === this.active;
      const shown = target.visible && here;
      tab.page.place({ ...target, visible: shown, covered: here && target.covered === true });
      tab.page.setNativeInput(this.input && shown);
      tab.page.setPicture?.(shown && target.picture === true);
      tab.page.setAgentControl(id === this.active ? this.agent : !shown);
    }
  }

  /** The selected tab, or the one named. */
  private placed(tabId: string | undefined): Tab | undefined {
    return this.tabs.get(tabId ?? this.active);
  }

  /** The shown tab's developer tools, at an element when `at` is given. */
  devtools(at?: { x: number; y: number }): void {
    this.tabs.get(this.active)?.page.devtools?.(at);
  }

  /** The system print dialog for the shown tab. */
  print(): Promise<boolean> {
    return this.tabs.get(this.active)?.page.print?.() ?? Promise.resolve(false);
  }

  async placementReady(tabId?: string): Promise<void> {
    await this.placed(tabId)?.page.placementReady();
  }

  /** A shown tab's picture, held in its place while an app overlay covers it. */
  picture(tabId?: string): Promise<string | undefined> {
    return this.placed(tabId)?.page.picture() ?? Promise.resolve(undefined);
  }

  isShown(tabId?: string): boolean {
    return this.placed(tabId)?.page.isShown() ?? false;
  }

  /** Where the selected tab goes, or with `tabId` where that one tab goes (split view). */
  place(target: Target, tabId?: string) {
    if (tabId === undefined) this.target = target;
    else this.pinned.set(tabId, target);
    this.apply();
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "ace.tabs.list") return this.snapshot();
    if (method === "ace.tabs.open") {
      const tabId = await this.openTab(OpenCommand.parse(params) ?? {});
      return { ...this.snapshot(), tabId };
    }
    if (method === "ace.tabs.switch") {
      const { tabId } = TabCommand.parse(params);
      this.tab(tabId);
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
    if (method === "ace.tabs.resize") {
      const { tabId, width, height } = ResizeCommand.parse(params);
      await this.tab(tabId).page.resize(width, height);
      return this.snapshot();
    }
    if (method === "ace.tabs.cdp") {
      const command = CdpCommand.parse(params);
      return this.tab(command.tabId).page.cdp(command.method, command.params);
    }
    return this.current().page.cdp(method, params);
  }

  private async remove(id: string) {
    const tab = this.tab(id);
    this.tabs.delete(id);
    this.pinned.delete(id);
    tab.stop();
    tab.stopInput();
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

  /** The person used a tab directly; reports which one. */
  onHumanInput(listener: (tabId?: string) => void) {
    this.humanInput.add(listener);
    return () => this.humanInput.delete(listener);
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

  /** When the daemon last drove any of the thread's tabs. */
  lastDriven(): number {
    let latest = -Infinity;
    for (const tab of this.tabs.values())
      latest = Math.max(latest, tab.page.lastDriven?.() ?? -Infinity);
    return latest;
  }

  /** The window is closing: every tab in it moves to the parking window. */
  evacuate(closing: BaseWindow, park: (size: { width: number; height: number }) => BaseWindow) {
    for (const tab of this.tabs.values()) tab.page.evacuate?.(closing, park);
  }

  /** The daemon link dropped: every tab stays alive and refuses what only the daemon decides. */
  orphan(): void {
    for (const tab of this.tabs.values()) tab.page.orphan?.();
  }

  /** A daemon adopts the tabs again: each starts from a clean CDP slate, its page untouched. */
  async readopt(): Promise<void> {
    await Promise.all([...this.tabs.values()].map((tab) => tab.page.readopt?.()));
  }

  close(): Promise<void> {
    return (this.closing ??= this.destroy());
  }

  private async destroy() {
    this.closed = true;
    await Promise.all(
      [...this.tabs.values()].map(async (tab) => {
        tab.stop();
        tab.stopInput();
        await tab.page.close();
      }),
    );
    this.tabs.clear();
    this.listeners.clear();
    await this.finish();
  }
}
