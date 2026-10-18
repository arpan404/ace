import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BaseWindow as AppWindow,
  dialog,
  WebContentsView,
  session as sessions,
  webContents,
  type BaseWindow,
  type Session,
  type WebContents,
} from "electron";
import type { BrowserOpen } from "@ace/protocol";
import type {
  BrowserContextAction,
  BrowserPageAction,
  BrowserPlacementReceipt,
  BrowserPlacement,
} from "../../shared/contract.ts";
import { emit } from "../ipc.ts";
import { BrowserShortcut } from "../../shared/contract.ts";
import { replayChord } from "../shortcuts.ts";
import type { ViewHost, ViewPage } from "./backend.ts";
import { PartitionPool } from "./partition-pool.ts";
import { PlacementBook, toWindowBounds } from "./placement.ts";
import { EmbeddedPage } from "./page.ts";
import { EmbeddedPageGroup } from "./page-group.ts";
import { CertificateExceptions } from "./certificates.ts";
import { clearPartition } from "./partition-cleanup.ts";
import { requestKind } from "./request-schemes.ts";
import { parkingOrigin, parkingWindowOptions } from "./parking.ts";

/** The app window whose renderer asked to place a view, and that renderer's page zoom. */
export interface PlacementHost {
  /** The renderer's `webContents.id`. */
  id: number;
  window: BaseWindow;
  zoom: number;
}

export interface ViewHostOptions {
  preload?: string | undefined;
  window(): BaseWindow | undefined;
  /** Electron's directory of persistent partitions (`userData/Partitions`). */
  partitionsDir: string;
  platform: NodeJS.Platform;
  log(message: string): void;
  /** The folder the person chose for this app's browser downloads, if any. */
  downloadFolder?(): string | undefined;
  /** The number of threads with native pages changed (they keep the app running). */
  onPages?(count: number): void;
}

/** How long a shortcut's focus handoff waits for the app's field before focusing the app. */
const handoffFallbackMs = 300;
/** Window changes after which a placed view's box is applied again, once they settle. */
const relayoutEvents = [
  "resize",
  "maximize",
  "unmaximize",
  "enter-full-screen",
  "leave-full-screen",
  "restore",
] as const;
const relayoutSettleMs = 100;

/** A placement's key: the thread's shown tab, or one tab of it by id (split view). */
const placementKey = (threadId: string, tabId?: string) =>
  tabId === undefined ? threadId : `${threadId}\u0000${tabId}`;
const placementOf = (key: string): { threadId: string; tabId?: string } => {
  const at = key.indexOf("\u0000");
  return at < 0 ? { threadId: key } : { threadId: key.slice(0, at), tabId: key.slice(at + 1) };
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
/** One persistent partition per thread, never shared with another thread or the app. */
const persistentName = (workspaceId: string, threadId: string) =>
  `ace-browser-${digest(`${workspaceId}:${threadId}`)}`;

/**
 * The app's in-app browser: Electron's own Chromium in `WebContentsView`s drawn inside a
 * thread's Browser panel. Persistent profiles get one partition per workspace/thread pair and ephemeral
 * ones an in-memory partition from a pool, cleared before it is lent again; never the app's
 * session or the person's Chrome profile. Auth popups retain their opener, dialogs await answers and downloads wait for
 * daemon consent. Permissions and service workers remain refused and audited. A hidden view the agent is not driving is background-throttled.
 */
export class EmbeddedViews implements ViewHost {
  private pages = new Map<string, EmbeddedPageGroup>();
  private popupContents = new Set<number>();
  private byContents = new Map<number, EmbeddedPage>();
  /** Partitions already given their handlers: the pool's few, plus one per persistent thread. */
  private configured = new Set<string>();
  private ephemeralPartitions = new PartitionPool("ace-browser-ephemeral-");
  private placements = new PlacementBook();
  private hosts = new Map<number, PlacementHost>();
  private generations = new Map<string, number>();
  private ready = new Map<string, number>();
  /** Each thread's placement keys that name a tab (split view). */
  private tabKeys = new Map<string, Set<string>>();
  /** Shown offscreen, never focused; unseen views render here while an agent drives them. */
  private parking: BaseWindow | undefined;
  /** App windows whose size changes re-apply the views placed in them. */
  private watched = new WeakSet<BaseWindow>();
  /** A shortcut in a native page sent typing to this renderer; see `FocusHandoff`. */
  private handoff: { host: number; page: EmbeddedPage; cancel(): void } | undefined;
  private options: ViewHostOptions;

  constructor(options: ViewHostOptions) {
    this.options = options;
  }

  async open(request: {
    sessionId: string;
    downloadDir?: string | undefined;
    options: BrowserOpen;
    viewport: { width: number; height: number };
  }): Promise<ViewPage> {
    const { threadId, workspaceId, profile } = request.options;
    if (this.pages.has(threadId)) throw new Error("This thread already has an embedded view");
    const ephemeral = profile !== "persistent";
    const pool = this.ephemeralPartitions;
    const partition = ephemeral
      ? pool.acquire()
      : `persist:${persistentName(workspaceId, threadId)}`;
    if (
      !ephemeral &&
      !this.configured.has(partition) &&
      [...this.configured].filter((name) => name.startsWith("persist:")).length >= 32
    )
      throw new Error(
        "The desktop browser profile limit was reached. Restart ace to open another profile.",
      );
    const partitionSession = this.configure(partition);
    const certificates = new CertificateExceptions();
    const group = new EmbeddedPageGroup(
      async () => {
        const view = new WebContentsView({
          webPreferences: {
            partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // Electron requires this for iframe preloads. The OS sandbox disables
            // the Node engine, and context isolation keeps the narrow bridge separate.
            nodeIntegrationInSubFrames: true,
            webviewTag: false,
            backgroundThrottling: false,
            spellcheck: false,
            // Chromium's built-in PDF viewer: a PDF opens in the tab instead of downloading.
            plugins: true,
          },
        });
        view.setVisible(false);
        view.setBounds({ x: 0, y: 0, ...request.viewport });
        // With no app window open the page starts in the parking window, drawn offscreen.
        const app = this.options.window();
        const window = app && !app.isDestroyed() ? app : this.park(request.viewport);
        window.contentView.addChildView(view);
        const page = new EmbeddedPage({
          view,
          authPreload: this.options.preload
            ? join(dirname(this.options.preload), "browser-auth-preload.cjs")
            : undefined,
          downloadDir: request.downloadDir,
          downloadFolder: () => this.options.downloadFolder?.(),
          certificates,
          session: partitionSession,
          released: undefined,
          window,
          park: (size) => this.park(size),
          platform: this.options.platform,
          log: this.options.log,
          forward: (accelerator) => this.forward(threadId, accelerator, page),
          contextAction: (action, url) => this.context({ threadId, action, url }),
          forget: () => this.byContents.delete(view.webContents.id),
          confirmLeave: (parent) =>
            dialog.showMessageBoxSync(parent, {
              type: "question",
              buttons: ["Leave", "Stay"],
              defaultId: 1,
              cancelId: 1,
              message: "Leave this page?",
              detail: "Changes you made may not be saved.",
            }) === 0,
          rememberPopup: (contents) => {
            this.byContents.set(contents.id, page);
            this.popupContents.add(contents.id);
            return () => {
              this.byContents.delete(contents.id);
              this.popupContents.delete(contents.id);
            };
          },
        });
        this.byContents.set(view.webContents.id, page);
        try {
          await page.prepare(request.viewport);
          return page;
        } catch (error) {
          await page.close();
          throw error;
        }
      },
      async () => {
        if (this.pages.get(threadId) === group) {
          this.pages.delete(threadId);
          for (const key of [threadId, ...(this.tabKeys.get(threadId) ?? [])]) {
            this.placements.forget(key);
            this.generations.delete(key);
            this.ready.delete(key);
            this.reportVisibility(key);
          }
          this.tabKeys.delete(threadId);
          this.options.onPages?.(this.pages.size);
        }
        // An idle hidden window must not outlive the views it holds.
        if (!this.pages.size && this.parking && !this.parking.isDestroyed()) this.parking.destroy();
        if (!this.pages.size) this.parking = undefined;
        if (ephemeral) pool.release(partition, await clearPartition(partitionSession));
      },
    );
    this.pages.set(threadId, group);
    this.options.onPages?.(this.pages.size);
    try {
      await group.openTab();
      this.apply(threadId);
      return group;
    } catch (error) {
      await group.close();
      throw error;
    }
  }

  /**
   * A deleted thread's persistent partition: its view closes and its stored data goes. A
   * partition this app never created is left alone rather than created to be cleared.
   */
  async purge(request: { threadId: string; workspaceId: string }): Promise<void> {
    await this.pages.get(request.threadId)?.close();
    const name = persistentName(request.workspaceId, request.threadId);
    const dir = join(this.options.partitionsDir, name);
    if (!existsSync(dir)) return;
    if (!(await clearPartition(sessions.fromPartition(`persist:${name}`))))
      throw new Error("Browser partition could not be cleared");
    await rm(dir, { recursive: true, force: true });
  }

  private park(size: { width: number; height: number }): BaseWindow {
    let window = this.parking;
    if (!window || window.isDestroyed()) {
      window = new AppWindow(parkingWindowOptions(size));
      window.setPosition(parkingOrigin.x, parkingOrigin.y);
      // Visible to the compositor (frames and rAF run) but offscreen and never focused,
      // so the person never sees it.
      window.showInactive();
      this.parking = window;
    }
    const [width = 0, height = 0] = window.getContentSize();
    if (size.width > width || size.height > height)
      window.setContentSize(Math.max(width, size.width), Math.max(height, size.height));
    return window;
  }

  /** Threads with a native page here; the app stays running while there are any. */
  /** A thread's shown tab (or the tab named) as a PNG `data:` URL, while it is on screen. */
  async snapshot(threadId: string, tabId?: string): Promise<string | undefined> {
    return this.pages.get(threadId)?.picture(tabId);
  }

  count(): number {
    return this.pages.size;
  }

  /** When the daemon last drove any native page here (agents browsing); never: -∞. */
  lastDriven(): number {
    let latest = -Infinity;
    for (const group of this.pages.values()) latest = Math.max(latest, group.lastDriven());
    return latest;
  }

  /**
   * An app window is closing. Its views move to the parking window before it goes, so no
   * page is destroyed or reloaded with it; the next window that shows a thread's page takes
   * its view back as it is.
   */
  evacuate(window: BaseWindow): void {
    let parking: BaseWindow | undefined;
    for (const group of this.pages.values())
      group.evacuate(window, (size) => (parking ??= this.park(size)));
  }

  /** Draw (or hide) a thread's view where a renderer's Browser tab shows its page. */
  async place(placement: BrowserPlacement, host: PlacementHost): Promise<BrowserPlacementReceipt> {
    this.hosts.set(host.id, host);
    this.watch(host.window);
    const { threadId, tabId } = placement;
    const key = placementKey(threadId, tabId);
    // Hiding a thread with no view here releases the claim: nothing of it is kept.
    if (!placement.visible && !this.pages.has(threadId)) {
      this.placements.release(key, host.id);
      return "hidden";
    }
    if (tabId !== undefined) {
      const keys = this.tabKeys.get(threadId) ?? new Set();
      this.tabKeys.set(threadId, keys.add(key));
    }
    const bounds = toWindowBounds(placement.bounds, host.zoom);
    this.placements.set(key, host.id, {
      bounds,
      visible: placement.visible,
      covered: placement.covered,
      device: placement.device,
    });
    this.apply(key);
    try {
      await this.pages.get(threadId)?.placementReady(tabId);
    } catch {
      return "unavailable";
    }
    if (!placement.visible) return "hidden";
    if (this.shownIn(key) !== host.id) return "superseded";
    return this.ready.get(key) === this.generations.get(key) &&
      (this.pages.get(threadId)?.isShown(tabId) ?? false)
      ? "shown"
      : "unavailable";
  }

  private reportVisibility(key: string): void {
    const { threadId, tabId } = placementOf(key);
    const shown =
      this.ready.has(key) &&
      this.ready.get(key) === this.generations.get(key) &&
      this.pages.get(threadId)?.isShown(tabId)
        ? this.shownIn(key)
        : undefined;
    for (const [id] of this.hosts) {
      const contents = webContents.fromId(id);
      if (contents && !contents.isDestroyed())
        emit(contents, "browser.visibility", {
          threadId,
          ...(tabId === undefined ? {} : { tabId }),
          visible: id === shown,
        });
    }
  }

  /** The renderer (`webContents.id`) showing a placement (`placementKey`) now, if any. */
  shownIn(key: string): number | undefined {
    const placement = this.placements.resolve(key);
    return placement.visible ? placement.host : undefined;
  }

  /** A renderer reloaded or closed: the views it placed no longer belong where it put them. */
  forgetHost(id: number): void {
    this.hosts.delete(id);
    if (this.handoff?.host === id) this.endHandoff();
    for (const threadId of this.placements.forgetHost(id)) this.apply(threadId);
  }

  /** Re-apply the views placed in a window whenever its size or state changes. */
  private watch(window: BaseWindow): void {
    if (this.watched.has(window) || window.isDestroyed()) return;
    this.watched.add(window);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const relayout = () => {
      timer = undefined;
      if (window.isDestroyed()) return;
      for (const [threadId] of this.pages)
        for (const key of [threadId, ...(this.tabKeys.get(threadId) ?? [])]) {
          const host = this.placements.resolve(key).host;
          if (host !== undefined && this.hosts.get(host)?.window === window) this.apply(key);
        }
    };
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(relayout, relayoutSettleMs);
    };
    for (const event of relayoutEvents) window.on(event as "resize", settle);
    window.once("closed", () => clearTimeout(timer));
  }

  /**
   * An app shortcut pressed in a thread's view goes to the app page showing that view. One that
   * moves typing to the page's own field (address, find) keeps the keys typed meanwhile and
   * moves focus once the field has it (`focusApp`), or shortly after if it never says so.
   */
  private forward(threadId: string, accelerator: string, page: EmbeddedPage): void {
    const host = this.placements.resolve(threadId).host;
    const contents = host === undefined ? undefined : webContents.fromId(host);
    if (!contents || contents.isDestroyed() || host === undefined) return;
    const shortcut = BrowserShortcut.safeParse({ threadId, accelerator });
    if (!shortcut.success) {
      contents.focus();
      replayChord(contents, accelerator, this.options.platform);
      return;
    }
    // Zoom keys change the page in place: typing stays in the page.
    if (
      accelerator === "CmdOrCtrl+=" ||
      accelerator === "CmdOrCtrl+-" ||
      accelerator === "CmdOrCtrl+0"
    ) {
      emit(contents, "browser.shortcut", shortcut.data);
      return;
    }
    if (accelerator === "CmdOrCtrl+L" || accelerator === "CmdOrCtrl+F") {
      this.endHandoff();
      page.beginHandoff();
      const timer = setTimeout(() => this.focusApp(host), handoffFallbackMs);
      this.handoff = { host, page, cancel: () => clearTimeout(timer) };
    } else contents.focus();
    emit(contents, "browser.shortcut", shortcut.data);
  }

  /** A context menu pick for the app page showing the thread's view to carry out. */
  private context(action: BrowserContextAction): void {
    const host = this.placements.resolve(action.threadId).host;
    const contents = host === undefined ? undefined : webContents.fromId(host);
    if (!contents || contents.isDestroyed()) return;
    emit(contents, "browser.context", action);
  }

  /** Print or open developer tools for the thread's shown tab; false when it has no view here. */
  async pageAction(request: BrowserPageAction): Promise<boolean> {
    const group = this.pages.get(request.threadId);
    if (!group) return false;
    if (request.action === "print") return group.print();
    group.devtools(request.inspect);
    return true;
  }

  /**
   * The app page (`webContents.id`) focused one of its own fields: the OS focus leaves any
   * native view now, and keys a shortcut's handoff kept are typed into that field.
   */
  focusApp(host: number): void {
    const contents = webContents.fromId(host);
    if (!contents || contents.isDestroyed()) return;
    contents.focus();
    const handoff = this.handoff?.host === host ? this.handoff : undefined;
    if (!handoff) return;
    this.handoff = undefined;
    handoff.cancel();
    for (const key of handoff.page.takeHandoff()) contents.sendInputEvent(key);
  }

  private endHandoff(): void {
    const handoff = this.handoff;
    this.handoff = undefined;
    handoff?.cancel();
    handoff?.page.takeHandoff();
  }

  /** Apply a placement (`placementKey`): the thread's shown tab, or one tab by id. */
  private apply(key: string): void {
    const { threadId, tabId } = placementOf(key);
    const page = this.pages.get(threadId);
    if (!page) return;
    const placement = this.placements.resolve(key);
    const host = placement.host === undefined ? undefined : this.hosts.get(placement.host);
    const window = host?.window;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    page.place(
      {
        window: window && !window.isDestroyed() ? window : undefined,
        bounds: placement.bounds,
        visible: placement.visible,
        covered: placement.covered === true,
        zoom: host?.zoom ?? 1,
        device: placement.device,
      },
      tabId,
    );
    if (page.isShown(tabId)) this.ready.set(key, generation);
    else this.ready.delete(key);
    this.reportVisibility(key);
    void page.placementReady(tabId).then(
      () => {
        if (this.pages.get(threadId) !== page || this.generations.get(key) !== generation) return;
        this.ready.set(key, generation);
        this.reportVisibility(key);
      },
      () => {},
    );
  }

  private configure(partition: string): Session {
    const partitionSession = sessions.fromPartition(partition);
    if (this.configured.has(partition)) return partitionSession;
    this.configured.add(partition);
    if (this.options.preload)
      partitionSession.registerPreloadScript({ type: "frame", filePath: this.options.preload });
    const page = (contents: WebContents | null | undefined) =>
      contents ? this.byContents.get(contents.id) : undefined;
    const permit = (contents: WebContents | null, permission: string, url: string) => {
      const owned = page(contents);
      if (permission === "clipboard-sanitized-write" && owned?.allowsClipboard()) return true;
      owned?.emit("ace.permissionDenied", { origin: originOf(url), permission });
      return false;
    };
    partitionSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(permit(contents, permission, details.requestingUrl || contents.getURL())),
    );
    partitionSession.setPermissionCheckHandler((contents, permission, origin) =>
      permit(contents, permission, origin),
    );
    partitionSession.setDevicePermissionHandler(() => false);
    partitionSession.on("will-download", (event, item, contents) => {
      if (page(contents)?.download(item)) return;
      event.preventDefault();
      page(contents)?.emit("ace.downloadDenied", {
        url: item.getURL().slice(0, 8192),
        suggestedFilename: item.getFilename().slice(0, 256),
      });
    });
    // Belt and braces with the page script: drop any worker that still registers.
    void partitionSession.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {});
    partitionSession.serviceWorkers.on("registration-completed", () => {
      void partitionSession.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {});
    });
    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      const kind = requestKind(details.url);
      if (kind === "refused") return callback({ cancel: true });
      if (
        kind === "fetched" &&
        details.webContentsId !== undefined &&
        (this.popupContents.has(details.webContentsId) ||
          this.byContents.get(details.webContentsId)?.isRestarting())
      ) {
        const owner = this.byContents.get(details.webContentsId);
        if (!owner) return callback({ cancel: true });
        return owner.checkPopupRequest(details.url, (allowed) => callback({ cancel: !allowed }));
      }
      if (kind === "socket") {
        const owner =
          details.webContentsId === undefined
            ? undefined
            : this.byContents.get(details.webContentsId);
        if (!owner) return callback({ cancel: true });
        return owner.checkSocket(details.url, (allowed) => callback({ cancel: !allowed }));
      }
      callback({});
    });
    return partitionSession;
  }
}

function originOf(value: string): string {
  try {
    return new URL(value).origin.slice(0, 8192);
  } catch {
    return "null";
  }
}
