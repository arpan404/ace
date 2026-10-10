import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BaseWindow as AppWindow,
  WebContentsView,
  session as sessions,
  webContents,
  type BaseWindow,
  type Session,
  type WebContents,
} from "electron";
import type { BrowserOpen } from "@ace/protocol";
import type { BrowserPlacementReceipt, BrowserPlacement } from "../../shared/contract.ts";
import { emit } from "../ipc.ts";
import { BrowserShortcut } from "../../shared/contract.ts";
import { replayChord } from "../shortcuts.ts";
import type { ViewHost, ViewPage } from "./backend.ts";
import { PartitionPool } from "./partition-pool.ts";
import { PlacementBook, toWindowBounds } from "./placement.ts";
import { EmbeddedPage } from "./page.ts";
import { EmbeddedPageGroup } from "./page-group.ts";
import { clearPartition } from "./partition-cleanup.ts";

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
  /** The connection the renderer showing a thread's view holds the page through, if any. */
  onClaim?(threadId: string, owner: string | undefined): void;
}

/** Schemes a view may load. http(s) requests are approved by the daemon through CDP Fetch. */
const passive = new Set(["about:", "data:", "blob:", "devtools:"]);
const fetched = new Set(["http:", "https:"]);
const sockets = new Set(["ws:", "wss:"]);

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
/** One persistent partition per thread, never shared with another thread or the app. */
const persistentName = (workspaceId: string, threadId: string) =>
  `ace-browser-${digest(`${workspaceId}:${threadId}`)}`;

/**
 * The app's in-app browser: Electron's own Chromium in `WebContentsView`s drawn inside a
 * thread's Browser panel. Persistent profiles get one partition per workspace/thread pair and ephemeral
 * ones an in-memory partition from a pool, cleared before it is lent again; never the app's
 * session or the person's Chrome profile. Popups stay in managed tabs, dialogs await answers and downloads wait for
 * daemon consent. Permissions and service workers remain refused and audited. A hidden view the agent is not driving is background-throttled.
 */
export class EmbeddedViews implements ViewHost {
  private pages = new Map<string, EmbeddedPageGroup>();
  private byContents = new Map<number, EmbeddedPage>();
  /** Partitions already given their handlers: the pool's few, plus one per persistent thread. */
  private configured = new Set<string>();
  private ephemeralPartitions = new PartitionPool("ace-browser-ephemeral-");
  private placements = new PlacementBook();
  private hosts = new Map<number, PlacementHost>();
  private generations = new Map<string, number>();
  private ready = new Map<string, number>();
  /** Never shown or focused; unseen views render here while an agent drives them. */
  private parking: BaseWindow | undefined;
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
    const window = this.options.window();
    if (!window || window.isDestroyed()) throw new Error("No ace window is open");
    const { threadId, workspaceId, profile } = request.options;
    if (this.pages.has(threadId)) throw new Error("This thread already has an embedded view");
    const ephemeral = profile !== "persistent";
    const pool = this.ephemeralPartitions;
    const partition = ephemeral
      ? pool.acquire()
      : `persist:${persistentName(workspaceId, threadId)}`;
    const partitionSession = this.configure(partition);
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
          },
        });
        view.setVisible(false);
        view.setBounds({ x: 0, y: 0, ...request.viewport });
        window.contentView.addChildView(view);
        const page = new EmbeddedPage({
          view,
          downloadDir: request.downloadDir,
          session: partitionSession,
          released: undefined,
          window,
          park: (size) => this.park(size),
          platform: this.options.platform,
          log: this.options.log,
          forward: (accelerator) => this.forward(threadId, accelerator),
          forget: () => this.byContents.delete(view.webContents.id),
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
          this.placements.forget(threadId);
          this.generations.delete(threadId);
          this.ready.delete(threadId);
          this.reportVisibility(threadId);
        }
        // An idle hidden window must not keep the app from quitting once its views are gone.
        if (!this.pages.size && this.parking && !this.parking.isDestroyed()) this.parking.destroy();
        if (!this.pages.size) this.parking = undefined;
        if (ephemeral) pool.release(partition, await clearPartition(partitionSession));
      },
    );
    this.pages.set(threadId, group);
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
      window = new AppWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        title: "ace browser",
        width: size.width,
        height: size.height,
      });
      this.parking = window;
    }
    const [width = 0, height = 0] = window.getContentSize();
    if (size.width > width || size.height > height)
      window.setContentSize(Math.max(width, size.width), Math.max(height, size.height));
    return window;
  }

  /** Draw (or hide) a thread's view where a renderer's Browser tab shows its page. */
  async place(placement: BrowserPlacement, host: PlacementHost): Promise<BrowserPlacementReceipt> {
    this.hosts.set(host.id, host);
    const { threadId } = placement;
    // Hiding a thread with no view here releases the claim: nothing of it is kept.
    if (!placement.visible && !this.pages.has(threadId)) {
      this.placements.release(threadId, host.id);
      return "hidden";
    }
    const bounds = toWindowBounds(placement.bounds, host.zoom);
    this.placements.set(threadId, host.id, {
      bounds,
      visible: placement.visible,
      owner: placement.owner,
      device: placement.device,
    });
    this.apply(threadId);
    try {
      await this.pages.get(threadId)?.placementReady();
    } catch {
      return "unavailable";
    }
    if (!placement.visible) return "hidden";
    if (this.shownIn(threadId) !== host.id) return "superseded";
    return this.ready.get(threadId) === this.generations.get(threadId) &&
      (this.pages.get(threadId)?.isShown() ?? false)
      ? "shown"
      : "unavailable";
  }

  private reportVisibility(threadId: string): void {
    const shown =
      this.ready.has(threadId) &&
      this.ready.get(threadId) === this.generations.get(threadId) &&
      this.pages.get(threadId)?.isShown()
        ? this.shownIn(threadId)
        : undefined;
    for (const [id] of this.hosts) {
      const contents = webContents.fromId(id);
      if (contents && !contents.isDestroyed())
        emit(contents, "browser.visibility", { threadId, visible: id === shown });
    }
  }

  /** The renderer (`webContents.id`) showing a thread's view now, if any shows it. */
  shownIn(threadId: string): number | undefined {
    const placement = this.placements.resolve(threadId);
    return placement.visible ? placement.host : undefined;
  }

  /** A renderer reloaded or closed: the views it placed no longer belong where it put them. */
  forgetHost(id: number): void {
    this.hosts.delete(id);
    for (const threadId of this.placements.forgetHost(id)) this.apply(threadId);
  }

  /** An app shortcut pressed in a thread's view goes to the app page showing that view. */
  private forward(threadId: string, accelerator: string): void {
    const host = this.placements.resolve(threadId).host;
    const contents = host === undefined ? undefined : webContents.fromId(host);
    if (contents && !contents.isDestroyed()) {
      contents.focus();
      const shortcut = BrowserShortcut.safeParse({ threadId, accelerator });
      if (shortcut.success) emit(contents, "browser.shortcut", shortcut.data);
      else replayChord(contents, accelerator, this.options.platform);
    }
  }

  private apply(threadId: string): void {
    const page = this.pages.get(threadId);
    if (!page) return;
    const placement = this.placements.resolve(threadId);
    const host = placement.host === undefined ? undefined : this.hosts.get(placement.host);
    const window = host?.window;
    const generation = (this.generations.get(threadId) ?? 0) + 1;
    this.generations.set(threadId, generation);
    this.ready.delete(threadId);
    page.place({
      window: window && !window.isDestroyed() ? window : undefined,
      bounds: placement.bounds,
      visible: placement.visible,
      zoom: host?.zoom ?? 1,
      device: placement.device,
    });
    this.options.onClaim?.(threadId, placement.owner);
    this.reportVisibility(threadId);
    void page.placementReady().then(
      () => {
        if (this.pages.get(threadId) !== page || this.generations.get(threadId) !== generation)
          return;
        this.ready.set(threadId, generation);
        this.reportVisibility(threadId);
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
    partitionSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(false);
      page(contents)?.emit("ace.permissionDenied", {
        origin: originOf(details.requestingUrl || contents.getURL()),
        permission,
      });
    });
    partitionSession.setPermissionCheckHandler(() => false);
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
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return callback({ cancel: true });
      }
      if (url.username || url.password) return callback({ cancel: true });
      if (passive.has(url.protocol) || fetched.has(url.protocol)) return callback({});
      if (sockets.has(url.protocol)) {
        const owner =
          details.webContentsId === undefined
            ? undefined
            : this.byContents.get(details.webContentsId);
        if (!owner) return callback({ cancel: true });
        return owner.checkSocket(details.url, (allowed) => callback({ cancel: !allowed }));
      }
      callback({ cancel: true });
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
