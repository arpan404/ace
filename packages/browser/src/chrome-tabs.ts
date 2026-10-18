import { z } from "zod";
import { BrowserDialog, type BrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import type { Schedule } from "./cdp-connection.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { ChromeDownloads } from "./chrome-downloads.ts";
import type { ChromeInstance } from "./chrome-instance.ts";
import type { AttachedTarget } from "./chrome-targets.ts";
import { consoleEntry } from "./console-entry.ts";
import { sizeHeadlessTab, type HeadlessDevice } from "./headless-size.ts";
import { BrowserInspection } from "./inspection.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { pageFrames } from "./page-frames.ts";
import { pageStatus } from "./page-status.ts";
import { browserOrigin } from "./policy.ts";
import { TabCdp } from "./tab-cdp.ts";
import { threadTabLimit } from "./tab-limits.ts";

const Navigated = z.object({
  frame: z.object({
    url: z.string(),
    urlFragment: z.string().optional(),
    parentId: z.string().optional(),
  }),
});
const SameDocument = z.object({ frameId: z.string(), url: z.string() });
const Dialog = z.object({
  type: BrowserDialog.shape.type,
  message: z.string(),
  defaultPrompt: z.string().optional(),
});
const WindowOpen = z.object({
  url: z.string().max(8192),
  windowName: z.string().optional(),
  windowFeatures: z.array(z.string()).optional(),
});
const Info = z.object({ targetInfo: z.object({ title: z.string(), url: z.string() }) });
const Detached = z.object({ sessionId: z.string() });
type Guard = Awaited<ReturnType<typeof installOriginGuard>>;
/** The running browser a session's tabs live in, and their cookie jar. */
export interface TabHost {
  instance: ChromeInstance;
  browserContextId?: string | undefined;
}
interface Tab {
  id: string;
  cdp: TabCdp;
  viewport: { width: number; height: number };
  /** Page zoom (1 is 100%) and the device emulated in place of `viewport`, if any. */
  zoom: number;
  device?: HeadlessDevice | undefined;
  /** An agent uses this tab: its popups reuse the page. */
  agent: boolean;
  /** Bumped each time the tab gets a new target, so a popup from an old target is refused. */
  binding: number;
  target?: AttachedTarget | undefined;
  guard?: Guard | undefined;
  mainFrame?: string | undefined;
  status: ReturnType<typeof pageStatus>;
  title: string;
  url: string;
  dialog?: BrowserDialog | undefined;
  popupKinds: boolean[];
  recovering?: Promise<void> | undefined;
  release(): void;
  stops: (() => void)[];
}

/**
 * One thread's tabs in ace's Chrome, popups included, up to the thread's tab limit. Each tab is
 * its own top-level target with its own window and flattened CDP session, so tabs render and
 * take input independently. `active` is only the tab the person is shown.
 */
export class ChromeTabs {
  private tabs = new Map<string, Tab>();
  private starting = 0;
  private activeId = "";
  private stopped = false;
  private maxTabs: number;
  private sequence = 0;
  private host: TabHost | undefined;
  private unwatch = () => {};
  private viewport: { width: number; height: number };
  readonly downloads: ChromeDownloads;
  readonly inspection: BrowserInspection;
  private request: BackendOpen;
  private deviceScaleFactor: number;
  private schedule: Schedule;
  constructor(request: BackendOpen, deviceScaleFactor: number, schedule: Schedule) {
    this.request = request;
    this.deviceScaleFactor = deviceScaleFactor;
    this.schedule = schedule;
    this.viewport = { width: 1280, height: 720 };
    this.maxTabs = request.maxTabs ?? threadTabLimit;
    this.inspection = new BrowserInspection(request.log);
    this.downloads = new ChromeDownloads(request, () =>
      this.host
        ? {
            root: this.host.instance.root,
            stagingDir: this.host.instance.stagingDir,
            browserContextId: this.host.browserContextId,
          }
        : undefined,
    );
  }
  /** Opens the thread's first tab, or the tabs it had before a restart with the same ids. */
  async start(host: TabHost): Promise<void> {
    this.attachHost(host);
    const restoring = (this.request.restoreTabs ?? []).slice(0, this.maxTabs);
    if (!restoring.length) {
      await this.create();
      return;
    }
    for (const entry of restoring) {
      const tab = await this.create(entry.tabId);
      tab.url = entry.url;
    }
    await Promise.all([...this.tabs.values()].map((tab) => this.reopen(tab)));
    this.request.changed?.();
  }
  /**
   * The browser restarted: every tab returns with its tab id at its last URL. Page state (DOM,
   * scripts, history) is lost; cookies in the profile survive.
   */
  async restore(host: TabHost): Promise<void> {
    if (this.stopped) throw new Error("Browser closed");
    this.attachHost(host);
    const tabs = [...this.tabs.values()];
    if (!tabs.length) throw new Error("Browser tab unavailable");
    for (const tab of tabs) {
      this.unbind(tab);
      tab.dialog = undefined;
      const target = await host.instance.targets.create({
        ...tab.viewport,
        browserContextId: host.browserContextId,
      });
      try {
        await this.bind(tab, target);
      } catch (error) {
        void host.instance.targets.close(target.targetId);
        throw error;
      }
    }
    await Promise.all(tabs.map((tab) => this.reopen(tab)));
    this.request.changed?.();
  }
  /** Loads a recreated tab's last address; a slow page fails on its own without the others. */
  private async reopen(tab: Tab): Promise<void> {
    if (tab.url === "about:blank") return;
    const deadline = new AbortController();
    const cancel = this.schedule(
      () => deadline.abort(new Error("The page did not reopen in time")),
      30_000,
    );
    try {
      await navigateCdp(tab.cdp, tab.url, AbortSignal.any([this.request.signal, deadline.signal]));
    } finally {
      cancel();
    }
  }
  current(): { cdp: BrowserCdp } {
    return this.tab(this.activeId);
  }
  tab(id: string): { cdp: BrowserCdp } {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }
  targets(): string[] {
    return [...this.tabs.values()].flatMap((tab) => (tab.target ? [tab.target.targetId] : []));
  }
  pageStatus(id = this.activeId) {
    return this.tabs.get(id)?.status.read() ?? { loading: false };
  }
  active(): string {
    return this.activeId;
  }
  url(id = this.activeId): string {
    return this.tabs.get(id)?.url ?? "about:blank";
  }
  viewportSize(id = this.activeId): { width: number; height: number } {
    return { ...(this.tabs.get(id)?.viewport ?? this.viewport) };
  }
  /** Sizes one tab; new tabs open at the size last set. */
  async resize(width: number, height: number, id = this.activeId): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    this.viewport = { width, height };
    tab.viewport = { width, height };
    tab.device = undefined;
    await sizeHeadlessTab(tab.cdp, tab, this.deviceScaleFactor);
  }
  /** One tab takes a device's size and scale until it is next resized. */
  async emulate(device: HeadlessDevice, id = this.activeId): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.device = { ...device };
    await sizeHeadlessTab(tab.cdp, tab, this.deviceScaleFactor);
  }
  /** Page zoom for one tab, kept through resizes, emulation and renderer restarts. */
  async zoom(factor: number, id = this.activeId): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.zoom = factor;
    await sizeHeadlessTab(tab.cdp, tab, this.deviceScaleFactor);
  }
  /** The web origins the thread's tabs show now. */
  origins(): string[] {
    const origins = new Set<string>();
    for (const tab of this.tabs.values()) {
      const origin = browserOrigin(tab.url);
      if (origin) origins.add(origin);
    }
    return [...origins];
  }
  list(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.id,
      url: tab.url.slice(0, 8192),
      title: tab.title,
      pending_dialog: tab.dialog,
      loading: tab.status.read().loading,
    }));
  }
  /** A new tab; `background` leaves the person's view where it is. */
  async open(options: { background?: boolean } = {}): Promise<string> {
    const tab = await this.create();
    if (!options.background) this.activate(tab.id);
    this.request.changed?.();
    return tab.id;
  }
  async switch(id: string): Promise<void> {
    if (!this.tabs.has(id)) throw new Error("Browser tab unavailable");
    this.activate(id);
    this.request.changed?.();
  }
  async close(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    if (this.tabs.size === 1) throw new Error("Close the browser to close its last tab");
    if (tab.target) await this.host?.instance.targets.close(tab.target.targetId);
    this.remove(tab, true);
  }
  dialog(): BrowserDialog | undefined {
    for (const tab of this.tabs.values()) if (tab.dialog) return tab.dialog;
    return undefined;
  }
  async answer(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    const tab = [...this.tabs.values()].find((entry) => entry.dialog?.dialogId === dialogId);
    if (!tab) throw new Error("Dialog no longer pending");
    await tab.cdp.send("Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    tab.dialog = undefined;
    this.request.changed?.();
  }
  /** Whether an agent uses this tab (ADR 0067, collaboration). */
  agentUse(id: string, active: boolean): void {
    const tab = this.tabs.get(id);
    if (tab) tab.agent = active;
  }
  async frames(
    id = this.activeId,
  ): Promise<{ frameId: string; cdp: BrowserCdp; parentId?: string }[]> {
    const tab = this.tabs.get(id);
    if (!tab?.guard) throw new Error("Browser tab unavailable");
    await tab.guard.ready();
    return pageFrames([tab.cdp, ...tab.guard.frameSessions()]);
  }
  /** Stops tracking; the caller closes the targets or disposes their context. */
  stop(): void {
    this.stopped = true;
    this.unwatch();
    this.downloads.stop();
    for (const tab of this.tabs.values()) this.remove(tab, false);
    this.inspection.clear();
  }
  private attachHost(host: TabHost): void {
    this.unwatch();
    this.host = host;
    const detached = (raw: unknown) => {
      const parsed = Detached.safeParse(raw);
      if (!parsed.success) return;
      host.instance.connection.forget(parsed.data.sessionId);
      for (const tab of this.tabs.values())
        if (tab.target?.sessionId === parsed.data.sessionId) this.remove(tab, true);
    };
    host.instance.root.on("Target.detachedFromTarget", detached);
    this.unwatch = () => host.instance.root.off("Target.detachedFromTarget", detached);
  }
  private activate(id: string): void {
    this.activeId = id;
  }
  private async create(id?: string): Promise<Tab> {
    const host = this.host;
    if (this.stopped || !host || this.tabs.size + this.starting >= this.maxTabs)
      throw new Error("Browser tab limit");
    const release = this.request.reserveTab?.() ?? (() => {});
    this.starting++;
    let tab: Tab | undefined;
    let target: AttachedTarget | undefined;
    try {
      target = await host.instance.targets.create({
        ...this.viewport,
        browserContextId: host.browserContextId,
      });
      tab = this.track(release, id);
      await this.bind(tab, target);
      if (!this.activeId) this.activate(tab.id);
      this.request.changed?.();
      return tab;
    } catch (error) {
      if (tab) this.remove(tab, false);
      else release();
      if (target) void host.instance.targets.close(target.targetId);
      throw error;
    } finally {
      this.starting--;
    }
  }
  /** A popup arrives paused. Agents never get popups: their links reuse the page. */
  private popup(opener: Tab, target: AttachedTarget): void {
    const reuse = opener.popupKinds.shift();
    const host = this.host;
    const refuse = () => void host?.instance.targets.close(target.targetId);
    if (
      this.stopped ||
      !host ||
      opener.agent ||
      reuse === true ||
      this.tabs.size + this.starting >= this.maxTabs
    ) {
      refuse();
      return;
    }
    let release: () => void;
    try {
      release = this.request.reserveTab?.() ?? (() => {});
    } catch {
      refuse();
      return;
    }
    const tab = this.track(release);

    this.starting++;
    void this.bind(tab, target)
      .then(() => {
        this.activate(tab.id);
        this.request.changed?.();
      })
      .catch(() => {
        this.remove(tab, false);
        refuse();
      })
      .finally(() => {
        this.starting--;
      });
  }
  /** Listeners that live as long as the tab, across browser restarts. */
  private track(release: () => void, restoredId?: string): Tab {
    const id = restoredId ?? `tab-${this.request.id?.() ?? ++this.sequence}`;
    const cdp = new TabCdp();
    const tab: Tab = {
      id,
      cdp,
      viewport: { ...this.viewport },
      zoom: 1,
      agent: false,
      binding: 0,
      status: pageStatus(cdp, () => this.request.changed?.()),
      title: "",
      url: "about:blank",
      popupKinds: [],
      release,
      stops: [],
    };
    this.tabs.set(id, tab);
    const on = (method: string, listener: (raw: unknown) => void) => cdp.on(method, listener);
    on("Page.javascriptDialogOpening", (raw) => {
      const parsed = Dialog.safeParse(raw);
      if (!parsed.success) return;
      // An agent leaving a page only it used goes unasked; anything else asks the person.
      if (parsed.data.type === "beforeunload" && this.request.leaveUnasked?.(id)) {
        void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        return;
      }
      tab.dialog = BrowserDialog.parse({
        dialogId: `${id}-dialog-${this.request.id?.() ?? ++this.sequence}`,
        tabId: id,
        type: parsed.data.type,
        message: parsed.data.message.slice(0, 4096),
        defaultPrompt: parsed.data.defaultPrompt?.slice(0, 4096),
      });
      this.request.changed?.();
    });
    on("Page.javascriptDialogClosed", () => {
      if (!tab.dialog) return;
      tab.dialog = undefined;
      this.request.changed?.();
    });
    on("Page.windowOpen", (raw) => this.windowOpen(tab, raw));
    on("Page.frameNavigated", (raw) => {
      const parsed = Navigated.safeParse(raw);
      if (!parsed.success || parsed.data.frame.parentId) return;
      tab.url = (parsed.data.frame.url + (parsed.data.frame.urlFragment ?? "")).slice(0, 8192);
      this.navigated(tab);
    });
    on("Page.navigatedWithinDocument", (raw) => {
      const parsed = SameDocument.safeParse(raw);
      if (!parsed.success || parsed.data.frameId !== tab.target?.targetId) return;
      tab.url = parsed.data.url.slice(0, 8192);
      this.navigated(tab);
    });
    for (const method of ["Page.domContentEventFired", "Page.loadEventFired"])
      on(method, () => this.title(tab));
    for (const method of ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"])
      on(method, (raw) => {
        const entry = consoleEntry(method, raw);
        if (entry) this.request.log({ ...entry, tabId: tab.id });
      });
    on("Inspector.targetCrashed", () => this.crashed(tab));
    tab.stops.push(this.downloads.watch(id, cdp));
    return tab;
  }
  private navigated(tab: Tab): void {
    this.request.navigation(tab.id);
    this.request.changed?.();
  }
  private title(tab: Tab): void {
    void tab.cdp
      .send("Target.getTargetInfo")
      .then((raw) => {
        const info = Info.parse(raw).targetInfo;
        tab.title = info.title.slice(0, 1024);
        this.request.changed?.();
      })
      .catch(() => {});
  }
  private windowOpen(tab: Tab, raw: unknown): void {
    const popup = WindowOpen.safeParse(raw);
    if (!popup.success) return;
    const reuse =
      tab.agent ||
      ((!popup.data.windowName || popup.data.windowName.startsWith("_")) &&
        !popup.data.windowFeatures?.length);
    if (tab.popupKinds.length < 8) tab.popupKinds.push(reuse);
    if (!reuse) return;
    const binding = tab.binding;
    void this.request
      .popup?.(popup.data.url, {
        tabId: tab.id,
        current: () => !this.stopped && this.tabs.get(tab.id) === tab && tab.binding === binding,
        navigate: async () => {
          await navigateCdp(tab.cdp, popup.data.url, this.request.signal);
        },
      })
      .catch(() => {});
  }
  /** A dead renderer is replaced by reloading the same target at its last URL. */
  private crashed(tab: Tab): void {
    if (tab.recovering || this.stopped) return;
    tab.dialog = undefined;
    tab.recovering = (async () => {
      // Renderer-side commands wait for a renderer; only the browser-side navigation starts one.
      await tab.cdp.send("Page.navigate", { url: tab.url });
      await tab.cdp.send("Runtime.enable");
      await sizeHeadlessTab(tab.cdp, tab, this.deviceScaleFactor);
      this.request.restarted?.(tab.id);
    })()
      .catch(() => {
        if (!this.stopped && this.tabs.get(tab.id) === tab)
          this.request.lost("The page could not reconnect after it crashed");
      })
      .finally(() => {
        tab.recovering = undefined;
      });
  }
  /** Installs everything on a paused target, then lets it run. */
  private async bind(tab: Tab, target: AttachedTarget): Promise<void> {
    const host = this.host;
    if (!host || this.stopped) throw new Error("Browser closed");
    tab.target = target;
    tab.binding++;
    tab.cdp.bind(host.instance.connection.session(target.sessionId));
    const stopPopups = host.instance.targets.popups(target.targetId, (popup) =>
      this.popup(tab, popup),
    );
    tab.stops.push(stopPopups);
    await tab.cdp.send("Page.enable");
    await tab.cdp.send("Runtime.enable");
    await tab.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await sizeHeadlessTab(tab.cdp, tab, this.deviceScaleFactor);
    tab.guard = await installOriginGuard(tab.cdp, this.request.allowed, this.request.initiator, {
      attach: (child) => this.inspection.attach(child, tab.id),
      detach: (child) => this.inspection.detach(child),
    });
    await this.inspection.attach(tab.cdp, tab.id);
    if (this.stopped || this.tabs.get(tab.id) !== tab) throw new Error("Browser closed");
    await host.instance.targets.resume(target);
  }
  private unbind(tab: Tab): void {
    tab.guard?.close();
    tab.guard = undefined;
    this.inspection.detach(tab.cdp);
    tab.cdp.bind(undefined);
    tab.target = undefined;
  }
  private remove(tab: Tab, notify: boolean): void {
    if (this.tabs.get(tab.id) !== tab) return;
    this.tabs.delete(tab.id);
    this.unbind(tab);
    tab.status.close();
    for (const stop of tab.stops.splice(0)) stop();
    tab.cdp.clear();
    tab.release();
    if (this.activeId === tab.id) this.activate(this.tabs.keys().next().value ?? "");
    if (!notify || this.stopped) return;
    if (this.tabs.size === 0) this.request.lost("All browser tabs closed");
    else this.request.changed?.();
  }
}
