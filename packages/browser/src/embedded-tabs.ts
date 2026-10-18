import { pageStatus } from "./page-status.ts";
import { pageFrames } from "./page-frames.ts";
import { EmbeddedDownloads } from "./embedded-downloads.ts";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { BrowserDialog, type BrowserTab } from "@ace/protocol";
import { decodeNativeTabs, type NativeTabsState } from "./native-tabs.ts";
import type { BackendOpen, BrowserCdp } from "./backend.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { BrowserInspection } from "./inspection.ts";
import { removeStaleOverlays } from "./annotation-install.ts";
import { consoleEntry } from "./console-entry.ts";
import { certificateErrors } from "./certificate-errors.ts";

const TabEvent = z.object({ tabId: z.string(), method: z.string(), params: z.unknown() });
const Crashed = z.object({ crashes: z.number().int().optional(), reason: z.string().optional() });
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
  status: ReturnType<typeof pageStatus>;
  certificates: ReturnType<typeof certificateErrors>;
  /** Whether the page plays sound and whether it is muted, as the desktop last said. */
  audio?: { audible: boolean; muted: boolean };
  /** The desktop gave up reloading this tab's renderer (`ace.rendererCrashed`). */
  crashed?: string;
  /** Waiting for the renderer a reload brings back to be re-armed. */
  revived: Set<() => void>;
}
/** Per-target CDP and guards keep background tabs isolated from active-page commands. */
export class EmbeddedTabs {
  private entries = new Map<string, Tab>();
  private activeId = "";
  private stopped = false;
  private sequence = 0;
  private reservations = new Set<() => void>();
  /** The desktop handed back views it kept through a lost link (ADR 0085). */
  private adopted = false;
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
    if (method === "ace.rendererCrashed") {
      const crash = Crashed.safeParse(params);
      tab.crashed =
        `The page crashed${crash.success && crash.data.crashes ? ` ${crash.data.crashes} times` : ""}` +
        `${crash.success && crash.data.reason ? ` (${crash.data.reason.slice(0, 256)})` : ""}` +
        " and stays down until it is reloaded";
      this.request.changed?.();
    }
    if (method === "ace.rendererRestarted") {
      delete tab.crashed;
      void (async () => {
        tab.guard?.close();
        this.inspection.detach(tab.cdp);
        tab.guard = await installOriginGuard(
          tab.cdp,
          this.request.allowed,
          this.request.initiator,
          {
            attach: (child) => this.inspection.attach(child, tab.state.tabId),
            detach: (child) => this.inspection.detach(child),
          },
        );
        await this.inspection.attach(tab.cdp, tab.state.tabId);
        await tab.cdp.send("ace.rendererReady");
        this.request.restarted?.(tab.state.tabId);
        for (const revived of tab.revived) revived();
        tab.revived.clear();
      })().catch(() => this.request.lost("The page could not reconnect after it crashed"));
    }
    // Each tab's console and uncaught errors, as the single-page relay logs its page's.
    const entry = consoleEntry(method, params);
    if (entry) this.request.log({ ...entry, tabId: tab.state.tabId });
    if (method === "Page.fileChooserOpened") {
      this.request.log({
        kind: "console",
        type: "file.chooser",
        text: 'The page needs a file. Use browser_act with action "upload" and the file input\'s snapshot ref.',
      });
    }
    if (method === "ace.printRequested") this.request.print?.(tab.state.tabId);
    if (method === "ace.audio") {
      const audio = z.object({ audible: z.boolean(), muted: z.boolean() }).safeParse(params);
      if (audio.success) {
        tab.audio = audio.data;
        this.request.changed?.();
      }
    }
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
    if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument")
      this.request.navigation(event.data.tabId);
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
    const decoded = this.decode(raw);
    if (decoded) void this.update(decoded).catch((error) => this.request.lost(String(error)));
  };
  /** Keeps every usable tab and reports the rest, so ace's list never silently drifts. */
  private decode(raw: unknown): NativeTabsState | undefined {
    const decoded = decodeNativeTabs(raw);
    if (!decoded) {
      this.request.log({
        kind: "console",
        type: "ace.tabs",
        text: "The desktop browser sent an unreadable tab list; the tab list may be stale.",
      });
      return undefined;
    }
    for (const text of decoded.problems)
      this.request.log({ kind: "console", type: "ace.tabs", text });
    return decoded.state;
  }
  private async read(raw: unknown): Promise<void> {
    const state = this.decode(raw);
    if (!state) throw new Error("The desktop browser returned an unreadable tab list");
    await this.update(state);
  }
  private frame = (raw: unknown) => {
    const target = z.object({ aceTabId: z.string().optional() }).safeParse(raw);
    if (target.success && (!target.data.aceTabId || target.data.aceTabId === this.activeId))
      this.entries.get(this.activeId)?.events.emit("Page.screencastFrame", raw);
  };
  private permission = (raw: unknown) => {
    this.entries.get(this.activeId)?.events.emit("ace.permissionDenied", raw);
  };
  private popup = (raw: unknown) => {
    const parsed = z
      .object({ url: z.string().max(8192), tabId: z.string().optional() })
      .safeParse(raw);
    if (!parsed.success || this.stopped) return;
    const id = parsed.data.tabId ?? this.activeId;
    const tab = this.entries.get(id);
    if (!tab) return;
    void this.request
      .popup?.(parsed.data.url, {
        tabId: id,
        current: () => !this.stopped && this.entries.get(id) === tab,
        navigate: async () => {
          await tab.cdp.send("Page.navigate", { url: parsed.data.url });
        },
      })
      .catch(() => {});
  };
  private async update(state: NativeTabsState): Promise<void> {
    if (this.stopped) return;
    for (const [id, tab] of this.entries)
      if (!state.tabs.some((entry) => entry.tabId === id)) {
        tab.guard?.close();
        tab.status.close();
        tab.certificates.close();
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
        status: pageStatus(cdp, () => this.request.changed?.()),
        certificates: certificateErrors(cdp, () => this.request.changed?.()),
        viewport: item.viewport ?? { width: 1280, height: 720 },
        revived: new Set(),
      };
      this.entries.set(item.tabId, tab);
      const adopted = this.adopted;
      tab.ready = (async () => {
        tab.guard = await installOriginGuard(cdp, this.request.allowed, this.request.initiator, {
          attach: (child) => this.inspection.attach(child, item.tabId),
          detach: (child) => this.inspection.detach(child),
        });
        await cdp.send("Page.enable");
        // A kept page may still show the overlay of the session that lost its link. This
        // enables Runtime (for the tab's console log) first, to find the old overlay's world.
        if (adopted) await removeStaleOverlays(cdp);
        else await cdp.send("Runtime.enable");
        // The browser's own warnings about the page (mixed content, CSP, certificates).
        await cdp.send("Log.enable");
        await this.inspection.attach(cdp, item.tabId);
      })();
    }
    this.activeId = state.activeTabId;
    await Promise.all([...this.entries.values()].map((tab) => tab.ready));
    this.request.changed?.();
  }
  /** `adopted`: the desktop kept these pages through a lost link; clean up after the old link. */
  async start(raw: unknown, adopted = false) {
    this.adopted = adopted;
    this.root.on("ace.tabs.event", this.emit);
    this.root.on("ace.tabs.changed", this.change);
    this.root.on("Page.screencastFrame", this.frame);
    this.root.on("ace.popupRequested", this.popup);
    this.root.on("ace.permissionDenied", this.permission);
    await this.read(raw);
    this.adopted = false;
  }
  current(): Tab {
    return this.tab(this.activeId);
  }
  tab(id: string): Tab {
    const tab = this.entries.get(id);
    if (!tab) throw new Error("Browser tab unavailable");
    return tab;
  }
  /** Why the tab's renderer is down, while the desktop has stopped reloading it. */
  crashed(id: string): string | undefined {
    return this.entries.get(id)?.crashed;
  }
  /**
   * Brings a crashed tab back: the desktop reloads it only when asked (`Page.reload`), and the
   * tab is usable again once its restarted renderer is re-armed.
   */
  async revive(id: string, signal: AbortSignal): Promise<void> {
    const tab = this.tab(id);
    if (!tab.crashed) return;
    const back = Promise.withResolvers<void>();
    const abort = () => back.reject(signal.reason);
    tab.revived.add(back.resolve);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await tab.cdp.send("Page.reload");
      await back.promise;
    } finally {
      tab.revived.delete(back.resolve);
      signal.removeEventListener("abort", abort);
    }
  }
  pageStatus(id = this.activeId) {
    return this.entries.get(id)?.status.read();
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
      certificate_error: tab.certificates.read(),
      audible: tab.audio?.audible,
      muted: tab.audio?.muted,
    }));
  }
  /** The person turns a tab's sound off or on; the desktop keeps that choice for the tab. */
  async mute(tabId: string, muted: boolean): Promise<void> {
    await this.tab(tabId).cdp.send("ace.audio.mute", { muted });
  }
  /**
   * The person proceeds past the certificate error shown for `url`: the desktop trusts that
   * origin's certificate for the thread's session and loads the page again.
   */
  async proceedCertificate(tabId: string, url: string): Promise<void> {
    const tab = this.tab(tabId);
    tab.certificates.expect(url);
    await tab.cdp.send("ace.certificate.proceed", { url });
  }
  private takeReservation() {
    const first = this.reservations.values().next().value;
    if (first) {
      this.reservations.delete(first);
      return first;
    }
    try {
      return this.request.reserveTab?.() ?? (() => {});
    } catch {
      // The desktop already opened this tab; refusing to track it would only desync ace.
      this.request.log({
        kind: "console",
        type: "ace.tabs",
        text: "The daemon's browser tab budget is full; this desktop tab is tracked over budget.",
      });
      return () => {};
    }
  }
  /**
   * Asks the desktop for another tab (ADR 0085: `ace.tabs.open {select}` answers with the tab
   * list and the new `tabId`). The new tab is blank; its guard is installed before this returns,
   * so the caller's first navigation is already policed. A desktop that answers with no new tab
   * keeps its one page: the caller gets the shown tab back and reuses it.
   */
  async open(options: { background?: boolean; tabId?: string } = {}) {
    const raw = await this.root.send("ace.tabs.open", {
      select: !(options.background ?? false),
      // A restored tab asks for the id it had; a desktop that cannot choose ignores it.
      ...(options.tabId ? { tabId: options.tabId } : {}),
    });
    const state = decodeNativeTabs(raw)?.state;
    if (!state) return this.activeId;
    await this.update(state);
    const opened = z.object({ tabId: z.string() }).safeParse(raw);
    return opened.success && this.entries.has(opened.data.tabId)
      ? opened.data.tabId
      : this.activeId;
  }
  /** Sizes a tab the panel does not show; the shown tab takes the panel's size. */
  async resize(tabId: string, width: number, height: number) {
    const tab = this.tab(tabId);
    await this.read(await this.root.send("ace.tabs.resize", { tabId, width, height }));
    tab.viewport = { width, height };
  }
  async switch(tabId: string) {
    await this.read(await this.root.send("ace.tabs.switch", { tabId }));
  }
  async close(tabId: string) {
    await this.read(await this.root.send("ace.tabs.close", { tabId }));
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
  async frames(id = this.activeId) {
    const tab = this.tab(id);
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
    this.root.off("ace.permissionDenied", this.permission);
    for (const tab of this.entries.values()) {
      tab.guard?.close();
      tab.status.close();
      tab.certificates.close();
      tab.release();
      tab.events.removeAllListeners();
    }
    this.inspection.clear();
  }
}
