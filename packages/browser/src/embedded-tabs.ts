import { pageFrames } from "./page-frames.ts";
import { EmbeddedDownloads } from "./embedded-downloads.ts";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { BrowserDialog, BrowserTab } from "@ace/protocol";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { BrowserInspection } from "./inspection.ts";

export const NativeTabs = z.object({
  activeTabId: z.string(),
  tabs: z
    .array(
      BrowserTab.extend({
        viewport: z
          .object({ width: z.number().positive(), height: z.number().positive() })
          .optional(),
      }),
    )
    .max(8),
});
const TabEvent = z.object({ tabId: z.string(), method: z.string(), params: z.unknown() });
type Guard = Awaited<ReturnType<typeof installOriginGuard>>;
interface Tab {
  state: BrowserTab;
  cdp: BrowserCdp;
  events: EventEmitter;
  guard?: Guard;
  release(): void;
  ready: Promise<void>;
  viewport: { width: number; height: number };
  dialog?: BrowserDialog;
}
/** Per-target CDP and guards keep background tabs isolated from active-page commands. */
export class EmbeddedTabs {
  private entries = new Map<string, Tab>();
  private activeId = "";
  private stopped = false;
  private sequence = 0;
  private reservations = new Set<() => void>();
  private root: BrowserCdp;
  private request: BackendOpen;
  readonly inspection: BrowserInspection;
  readonly downloadsManager: EmbeddedDownloads;
  constructor(root: BrowserCdp, request: BackendOpen) {
    this.root = root;
    this.request = request;
    this.inspection = new BrowserInspection(request.log);
    this.downloadsManager = new EmbeddedDownloads(request, root);
  }
  private emit = (raw: unknown) => {
    const event = TabEvent.safeParse(raw);
    if (!event.success) return;
    const tab = this.entries.get(event.data.tabId);
    if (!tab) return;
    const { method, params } = event.data;
    this.downloadsManager.handle(event.data.tabId, method, params);
    if (method === "ace.viewport") {
      const parsed = z
        .object({ width: z.number().positive(), height: z.number().positive() })
        .safeParse(params);
      if (parsed.success) {
        tab.viewport = parsed.data;
        this.request.changed?.();
      }
    }
    if (method === "Page.javascriptDialogOpening") {
      const parsed = z
        .object({
          type: BrowserDialog.shape.type,
          message: z.string(),
          defaultPrompt: z.string().optional(),
        })
        .safeParse(params);
      if (parsed.success) {
        tab.dialog = BrowserDialog.parse({
          dialogId: `${tab.state.tabId}-dialog-${++this.sequence}`,
          tabId: tab.state.tabId,
          ...parsed.data,
          message: parsed.data.message.slice(0, 4096),
          defaultPrompt: parsed.data.defaultPrompt?.slice(0, 4096),
        });
        this.request.changed?.();
      }
    } else if (method === "Page.javascriptDialogClosed") {
      delete tab.dialog;
      this.request.changed?.();
    }
    if (method === "Page.frameNavigated") this.request.navigation();
    if (method === "ace.webSocketRequested") {
      const check = z.object({ id: z.string(), url: z.string() }).safeParse(params);
      if (check.success)
        void this.request
          .allowed(check.data.url)
          .then((allowed) => tab.cdp.send("ace.webSocketDecision", { id: check.data.id, allowed }))
          .catch(() => {});
    }
    tab.events.emit(method, params);
  };
  private change = (raw: unknown) => {
    const parsed = NativeTabs.safeParse(raw);
    if (parsed.success)
      void this.update(parsed.data).catch((error) => this.request.lost(String(error)));
  };
  private frame = (raw: unknown) => {
    const target = z.object({ aceTabId: z.string().optional() }).safeParse(raw);
    if (target.success && (!target.data.aceTabId || target.data.aceTabId === this.activeId))
      this.entries.get(this.activeId)?.events.emit("Page.screencastFrame", raw);
  };
  private popup = (raw: unknown) => {
    const parsed = z.object({ url: z.string().max(8192) }).safeParse(raw);
    if (!parsed.success) return;
    void (async () => {
      if (
        !(await this.request.allowed(parsed.data.url, {
          navigation: true,
          human: this.request.initiator?.() ?? false,
        }))
      )
        return;
      const id = await this.open();
      await this.switch(id);
      await this.current().cdp.send("Page.navigate", { url: parsed.data.url });
    })().catch(() => {});
  };
  private async update(state: z.infer<typeof NativeTabs>): Promise<void> {
    if (this.stopped) return;
    for (const [id, tab] of this.entries)
      if (!state.tabs.some((entry) => entry.tabId === id)) {
        tab.guard?.close();
        this.inspection.detach(tab.cdp);
        tab.release();
        tab.events.removeAllListeners();
        this.entries.delete(id);
      }
    for (const item of state.tabs) {
      const existing = this.entries.get(item.tabId);
      if (existing) {
        existing.state = item;
        continue;
      }
      const events = new EventEmitter();
      const cdp: BrowserCdp = {
        send: (method, params) =>
          method === "Page.screencastFrameAck"
            ? Promise.resolve(undefined)
            : this.root.send("ace.tabs.cdp", {
                tabId: item.tabId,
                method,
                ...(params ? { params } : {}),
              }),
        on: (method, listener) => events.on(method, listener),
        off: (method, listener) => events.off(method, listener),
      };
      const tab: Tab = {
        state: item,
        cdp,
        events,
        release: this.takeReservation(),
        ready: Promise.resolve(),
        viewport: item.viewport ?? { width: 1280, height: 720 },
      };
      this.entries.set(item.tabId, tab);
      tab.ready = (async () => {
        tab.guard = await installOriginGuard(cdp, this.request.allowed, this.request.initiator, {
          attach: (child) => this.inspection.attach(child, item.tabId),
          detach: (child) => this.inspection.detach(child),
        });
        await cdp.send("Page.enable");
        await this.inspection.attach(cdp, item.tabId);
      })();
    }
    const changed = this.activeId !== state.activeTabId;
    this.activeId = state.activeTabId;
    await Promise.all([...this.entries.values()].map((tab) => tab.ready));
    if (changed) this.request.navigation();
    this.request.changed?.();
  }
  async start(state: z.infer<typeof NativeTabs>) {
    this.root.on("ace.tabs.event", this.emit);
    this.root.on("ace.tabs.changed", this.change);
    this.root.on("Page.screencastFrame", this.frame);
    this.root.on("ace.popupRequested", this.popup);
    await this.update(state);
  }
  current(): Tab {
    const tab = this.entries.get(this.activeId);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }
  active() {
    return this.activeId;
  }
  list(): BrowserTab[] {
    return [...this.entries.values()].map((tab) => ({
      tabId: tab.state.tabId,
      url: tab.state.url,
      title: tab.state.title,
      pending_dialog: tab.dialog,
    }));
  }
  private takeReservation() {
    const first = this.reservations.values().next().value;
    if (first) {
      this.reservations.delete(first);
      return first;
    }
    return this.request.reserveTab?.() ?? (() => {});
  }
  async open() {
    const release = this.request.reserveTab?.() ?? (() => {});
    this.reservations.add(release);
    try {
      const before = new Set(this.entries.keys());
      const state = NativeTabs.parse(await this.root.send("ace.tabs.open"));
      await this.update(state);
      const id = state.tabs.find((tab) => !before.has(tab.tabId))?.tabId;
      if (!id) throw new Error("Browser tab unavailable");
      return id;
    } finally {
      if (this.reservations.delete(release)) release();
    }
  }
  async switch(tabId: string) {
    await this.update(NativeTabs.parse(await this.root.send("ace.tabs.switch", { tabId })));
  }
  async close(tabId: string) {
    await this.update(NativeTabs.parse(await this.root.send("ace.tabs.close", { tabId })));
  }
  dialog() {
    return [...this.entries.values()].find((tab) => tab.dialog)?.dialog;
  }
  async answer(dialogId: string, accept: boolean, promptText?: string) {
    const tab = [...this.entries.values()].find(
      (candidate) => candidate.dialog?.dialogId === dialogId,
    );
    if (!tab) throw new Error("Dialog no longer pending");
    await tab.cdp.send("Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    delete tab.dialog;
    this.request.changed?.();
  }
  async frames() {
    const tab = this.current();
    await tab.ready;
    await tab.guard?.ready();
    return pageFrames([tab.cdp, ...(tab.guard?.frameSessions() ?? [])]);
  }
  downloads() {
    return this.downloadsManager.transfers.list();
  }
  stop() {
    this.stopped = true;
    this.downloadsManager.stop();
    for (const release of this.reservations) release();
    this.reservations.clear();
    this.root.off("ace.tabs.event", this.emit);
    this.root.off("ace.tabs.changed", this.change);
    this.root.off("Page.screencastFrame", this.frame);
    this.root.off("ace.popupRequested", this.popup);
    for (const tab of this.entries.values()) {
      tab.guard?.close();
      tab.release();
      tab.events.removeAllListeners();
    }
    this.inspection.clear();
  }
}
