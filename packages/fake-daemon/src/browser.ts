import { BrowserOrigin, type BrowserOriginGrant } from "@ace/protocol";
import { BrowserOriginError, browserOrigin } from "@ace/browser/policy";
import type {
  BrowserInput,
  BrowserTab,
  BrowserDownload,
  BrowserDialog,
  BrowserEvaluateGrant,
} from "@ace/protocol";
import { BrowserDocumentHistory } from "./browser-history.ts";
import { pairPhoneFrame, sitePage } from "./preview-page.ts";

/**
 * The browser and preview services (ADR 0008, 0009) as a client sees them, simulated in
 * memory: one agent-driven browser per thread with a screencast frame and take-over /
 * hand-back, plus the dev servers the preview gateway detected. Shapes follow
 * `BrowserState`, `BrowserFrame`, `BrowserInput` and `PreviewDescriptor` in `@ace/protocol`.
 */
export interface BrowserView {
  threadId: string;
  controller: "agent" | "human" | "none";
  /**
   * The connection holding control while `controller` is `human` (BrowserState.owner). The
   * service never names the agent driving it; clients find that in the thread's agent tree.
   */
  owner?: string;
  url: string;
  closed: boolean;
  /** Where the page runs: the desktop app's embedded view, or the daemon's headless Chromium. */
  backend?: "embedded" | "headless";
  status?: "ready" | "paused" | "recovering";
  takeoverMode?: "shared" | "private";
  tabs?: BrowserTab[];
  activeTabId?: string;
  downloads?: BrowserDownload[];
  pending_dialog?: BrowserDialog | undefined;
  reason?: string;
}
export interface ScreenFrame {
  sequence: number;
  /** Image URL for the frame (the daemon sends base64 JPEG; the fake draws SVG). */
  src: string;
  width: number;
  height: number;
}
export interface PreviewServer {
  port: number;
  origin?: string;
  name?: string;
  source: "listener" | "terminal" | "launch";
}
export type ForwardedInput =
  | { kind: "mouse"; event: "mouseMoved" | "mousePressed" | "mouseReleased"; x: number; y: number }
  | { kind: "key"; event: "keyDown"; key: string; text?: string };

interface Entry {
  generation: number;
  view?: BrowserView;
  frame?: ScreenFrame;
  servers: PreviewServer[];
  typed: string;
  /** The page's viewport in CSS pixels; a real browser starts at 760x900 here too. */
  viewport: { width: number; height: number };
  /** What the page draws: the seeded pairing page, or any other address. */
  page: "pair" | "site";
}

/** BrowserCommand `resize` bounds in `@ace/protocol`. */
const clampDimension = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));

export class FakeBrowser {
  private history = new BrowserDocumentHistory();
  private privateLifecycle: ((threadId: string, paused: boolean) => void) | undefined;
  bindPrivateLifecycle(lifecycle: (threadId: string, paused: boolean) => void): void {
    this.privateLifecycle = lifecycle;
  }
  private navigatePolicy: ((threadId: string, url: string) => Promise<void>) | undefined;
  bindNavigation(policy: (threadId: string, url: string) => Promise<void>): void {
    this.navigatePolicy = policy;
  }
  async navigateAgent(threadId: string, url: string): Promise<void> {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    if (entry.view.controller !== "agent") throw new Error("Browser controlled by human");
    if (!this.navigatePolicy) throw new Error("Browser agent policy unavailable");
    this.originsClearPage(threadId);
    await this.navigatePolicy(threadId, url);
    if (entry.view.controller !== "agent" || entry.view.closed)
      throw new Error("Browser controller changed during approval");
    entry.view = { ...entry.view, url: new URL(url).href };
    this.updateTab(entry);
    if (entry.view.activeTabId) this.history.visit(entry.view.activeTabId, entry.view.url);
    entry.page = "site";
    this.paint(entry, entry.typed);
  }
  private tabSequence = 0;
  private evaluations = new Map<string, BrowserEvaluateGrant[]>();
  private origins = new Map<string, Map<string, BrowserOriginGrant>>();
  private entries = new Map<string, Entry>();
  private watchers = new Set<() => void>();
  private revision = 0;
  readonly available = true;
  /**
   * The daemon's first browser needs Chromium downloaded (ADR 0055 acquisition). While set, the
   * next `browser.open` reports download progress and waits for `finishDownload()`.
   */
  private download: { total: number; done: Promise<void>; finish(): void } | undefined;
  /** Input forwarded while a person had control: what the daemon received. */
  readonly inputs: { threadId: string; input: ForwardedInput }[] = [];
  readonly wireInputs: { threadId: string; input: BrowserInput }[] = [];
  get version(): number {
    return this.revision;
  }
  /** Make the next open wait on a Chromium download of `total` bytes. */
  requireDownload(total: number): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.download = { total, done: promise, finish: resolve };
  }
  /** The pending download, if the next open has to wait on one. */
  pendingDownload(): { total: number; done: Promise<void> } | undefined {
    return this.download;
  }
  finishDownload(): void {
    const download = this.download;
    this.download = undefined;
    download?.finish();
  }
  subscribe(listener: () => void): () => void {
    if (this.watchers.size >= 64) throw new Error("subscription_limit");
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }
  generation(threadId: string): number {
    return this.entries.get(threadId)?.generation ?? 0;
  }
  view(threadId: string): BrowserView | undefined {
    return this.entries.get(threadId)?.view;
  }
  frame(threadId: string): ScreenFrame | undefined {
    return this.entries.get(threadId)?.frame;
  }
  servers(threadId: string): readonly PreviewServer[] {
    return this.entries.get(threadId)?.servers ?? [];
  }
  /** A person takes control through their client's connection (`owner`). */
  async takeover(
    threadId: string,
    owner = "fake-connection",
    mode: "shared" | "private" = "shared",
  ): Promise<void> {
    const current = this.view(threadId)?.owner;
    if (current && current !== owner)
      throw new Error("Browser already controlled by another connection");
    if (this.view(threadId)?.takeoverMode === "private" && mode !== "private")
      throw new Error("Private browser requires explicit handback");
    if (mode === "private") this.privateLifecycle?.(threadId, true);
    this.control(threadId, "human", owner);
    const view = this.view(threadId);
    if (view) {
      view.takeoverMode = mode;
      view.status = "ready";
      delete view.reason;
    }
    this.changed();
  }
  disconnect(owner: string): void {
    for (const [threadId, entry] of this.entries)
      if (entry.view?.owner === owner) {
        if (entry.view.takeoverMode === "private") {
          delete entry.view.owner;
          entry.view.status = "paused";
          entry.view.controller = "none";
          entry.view.reason = "Private takeover disconnected; explicit handback required";
          this.privateLifecycle?.(threadId, true);
          this.changed();
        } else this.control(threadId, "agent");
      }
  }
  async handback(threadId: string): Promise<void> {
    this.control(threadId, "agent");
    this.privateLifecycle?.(threadId, false);
    const view = this.view(threadId);
    if (view) {
      view.takeoverMode = "shared";
      view.status = "ready";
      delete view.reason;
    }
    this.changed();
  }
  input(threadId: string, input: ForwardedInput): void {
    if (this.view(threadId)?.controller !== "human") return;
    if (this.inputs.length >= 256) this.inputs.shift();
    this.inputs.push({ threadId, input });
  }
  wireInput(threadId: string, input: BrowserInput): void {
    if (this.view(threadId)?.controller !== "human") return;
    if (this.wireInputs.length >= 256) this.wireInputs.shift();
    this.wireInputs.push({ threadId, input });
    if (
      input.kind === "mouse" &&
      (input.event === "mousePressed" || input.event === "mouseReleased")
    )
      this.input(threadId, { kind: "mouse", event: input.event, x: input.x, y: input.y });
    if (input.kind === "key" && input.event === "keyDown")
      this.input(threadId, {
        kind: "key",
        event: input.event,
        key: input.key,
        ...(input.text ? { text: input.text } : {}),
      });
  }
  /**
   * Size the page's viewport (BrowserCommand `resize`); the next frame is painted at that size,
   * so a client showing it 1:1 fills its pane.
   */
  resize(threadId: string, width: number, height: number): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const viewport = { width: clampDimension(width), height: clampDimension(height) };
    if (viewport.width === entry.viewport.width && viewport.height === entry.viewport.height)
      return;
    entry.viewport = viewport;
    if (entry.view && !entry.view.closed) this.paint(entry, entry.typed);
  }
  /**
   * A person (holding control) navigates: the page changes and control stays theirs. A local
   * address nothing listens on fails the way Chromium reports it; so does an unsafe port.
   */
  originsList(threadId: string): BrowserOriginGrant[] {
    return [...(this.origins.get(threadId)?.values() ?? [])].toSorted((a, b) =>
      a.origin.localeCompare(b.origin),
    );
  }
  originsGrant(threadId: string, raw: string, grantedAt = 0): void {
    const origin = BrowserOrigin.parse(raw),
      grants = this.origins.get(threadId) ?? new Map<string, BrowserOriginGrant>();
    if (
      !grants.has(origin) &&
      (grants.size >= 256 ||
        [...this.origins.values()].reduce((sum, entries) => sum + entries.size, 0) >= 16_384)
    )
      throw new Error("Browser origin grant limit; revoke an origin first");
    if (grants.get(origin)?.scope !== "thread")
      grants.set(origin, { origin, grantedAt, scope: "thread" });
    this.origins.set(threadId, grants);
  }
  originsPageGrant(threadId: string, raw: string, grantedAt: number): void {
    const origin = BrowserOrigin.parse(raw);
    if (this.origins.get(threadId)?.get(origin)?.scope === "thread") return;
    this.originsGrant(threadId, origin, grantedAt);
    this.origins.get(threadId)?.set(origin, { origin, grantedAt, scope: "page" });
  }
  originsClearPage(threadId: string): void {
    for (const [origin, grant] of this.origins.get(threadId) ?? [])
      if (grant.scope === "page") this.origins.get(threadId)?.delete(origin);
  }
  originsRevoke(threadId: string, origin: string): void {
    this.origins.get(threadId)?.delete(BrowserOrigin.parse(origin));
  }
  navigate(threadId: string, url: string, grantedAt = 0): string {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    if (entry.view.controller !== "human") throw new Error("Browser controller mismatch");
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`net::ERR_INVALID_URL at ${url}`);
    }
    const origin = browserOrigin(url);
    if (!origin || !["http:", "https:"].includes(parsed.protocol))
      throw new BrowserOriginError(url, "invalid_origin", "Browser requires an HTTP(S) address");
    this.originsGrant(threadId, origin, grantedAt);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if ([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25].includes(port))
      throw new Error(`net::ERR_UNSAFE_PORT at ${url}`);
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(parsed.hostname);
    if (local && !entry.servers.some((server) => server.port === port))
      throw new Error(`net::ERR_CONNECTION_REFUSED at ${url}`);
    if (parsed.hostname.endsWith(".invalid"))
      throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
    entry.view = { ...entry.view, url: parsed.href };
    this.updateTab(entry);
    if (entry.view.activeTabId) this.history.visit(entry.view.activeTabId, entry.view.url);
    entry.page =
      local && entry.servers.some((server) => server.port === port && server.name === "web")
        ? "pair"
        : "site";
    this.paint(entry, entry.typed);
    return parsed.href;
  }
  /** Scripting: an agent opens the browser on a page and starts typing into it. */
  drive(
    threadId: string,
    options: { url: string; typed?: string; backend?: "embedded" | "headless" },
  ): void {
    const entry = this.entry(threadId);
    for (const tab of entry.view?.tabs ?? []) this.history.remove(tab.tabId);
    if (!entry.view || entry.view.closed) entry.generation++;
    entry.view = {
      threadId,
      controller: "agent",
      url: options.url,
      closed: false,
      ...(options.backend ? { backend: options.backend } : {}),
    };
    const tabId = `tab-${++this.tabSequence}`;
    entry.view.tabs = [{ tabId, url: options.url, title: "Fixture page" }];
    entry.view.activeTabId = tabId;
    this.history.visit(tabId, options.url);
    entry.view.downloads = [];
    entry.view.takeoverMode = "shared";
    entry.view.status = "ready";
    entry.page = options.url === "about:blank" ? "site" : "pair";
    this.paint(entry, options.typed ?? "");
  }
  /** Scripting: the agent types more of the device name (ignored while a person has control). */
  type(threadId: string, typed: string): void {
    const entry = this.entries.get(threadId);
    if (entry?.view?.controller === "agent" && entry.page === "pair") this.paint(entry, typed);
  }
  /** Scripting: the preview gateway detected a dev server for this thread. */
  /** Set, the daemon refuses forwarding and sign-in links with this code (tests, scenarios). */
  previewRefusal: string | undefined;
  /** Refuse forwarding and sign-in links with `code` from now on, or accept them again. */
  refusePreviews(code: string | undefined): void {
    this.previewRefusal = code;
  }
  serve(threadId: string, server: PreviewServer): void {
    const entry = this.entry(threadId);
    if (entry.servers.length >= 64 && !entry.servers.some((s) => s.port === server.port))
      throw new Error("preview_limit");
    entry.servers = [...entry.servers.filter((s) => s.port !== server.port), server];
    this.changed();
  }
  navigationHistory(threadId: string) {
    const tabId = this.view(threadId)?.activeTabId;
    if (!tabId) throw new Error("Browser tab unavailable");
    return this.history.capabilities(tabId);
  }
  navigateHistory(threadId: string, direction: "back" | "forward" | "reload") {
    const entry = this.entries.get(threadId);
    const view = entry?.view;
    if (!entry || !view || view.closed || !view.activeTabId) throw new Error("Browser closed");
    if (view.controller !== "human") throw new Error("Browser controller mismatch");
    const url = this.history.move(view.activeTabId, direction);
    if (url !== undefined) {
      entry.view = { ...view, url };
      this.updateTab(entry);
      entry.page = "site";
      this.paint(entry, entry.typed);
    }
    return { ok: true };
  }
  tabsList(threadId: string): BrowserTab[] {
    return this.view(threadId)?.tabs ?? [];
  }
  tabOpen(threadId: string, url = "about:blank"): void {
    const view = this.view(threadId);
    if (!view || view.closed) throw new Error("Browser closed");
    if (
      (view.tabs?.length ?? 0) >= 8 ||
      [...this.entries.values()].reduce(
        (sum, entry) => sum + (entry.view?.closed ? 0 : (entry.view?.tabs?.length ?? 0)),
        0,
      ) >= 32
    )
      throw new Error("Browser tab limit");
    const tabId = `tab-${++this.tabSequence}`;
    view.tabs = [...(view.tabs ?? []), { tabId, url, title: "Fixture page" }];
    this.history.visit(tabId, url);
    this.tabSwitch(threadId, tabId);
  }
  tabSwitch(threadId: string, tabId: string): void {
    const entry = this.entries.get(threadId),
      tab = entry?.view?.tabs?.find((candidate) => candidate.tabId === tabId);
    if (!entry?.view || !tab) throw new Error("Browser tab unavailable");
    entry.view.activeTabId = tabId;
    entry.view.url = tab.url;
    entry.view.pending_dialog = this.tabsList(threadId).find(
      (candidate) => candidate.pending_dialog,
    )?.pending_dialog;
    entry.page = "site";
    this.paint(entry, "");
  }
  tabClose(threadId: string, tabId: string): void {
    const view = this.view(threadId);
    if (!view?.tabs?.some((tab) => tab.tabId === tabId)) throw new Error("Browser tab unavailable");
    if (view.tabs.length === 1) throw new Error("Close the browser to close its last tab");
    view.tabs = view.tabs.filter((tab) => tab.tabId !== tabId);
    this.history.remove(tabId);
    view.pending_dialog = view.tabs.find((tab) => tab.pending_dialog)?.pending_dialog;
    if (view.activeTabId === tabId && view.tabs[0]) this.tabSwitch(threadId, view.tabs[0].tabId);
    else this.changed();
  }
  dialogOpen(threadId: string, dialog: BrowserDialog): void {
    const tab = this.tabsList(threadId).find((candidate) => candidate.tabId === dialog.tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.pending_dialog = dialog;
    const view = this.view(threadId);
    if (view)
      view.pending_dialog = this.tabsList(threadId).find(
        (candidate) => candidate.pending_dialog,
      )?.pending_dialog;
    this.changed();
  }
  dialogAnswer(threadId: string, dialogId: string): void {
    const view = this.view(threadId);
    if (view?.pending_dialog?.dialogId !== dialogId) throw new Error("Dialog no longer pending");
    const tab = this.tabsList(threadId).find(
      (candidate) => candidate.pending_dialog?.dialogId === dialogId,
    );
    if (tab) delete tab.pending_dialog;
    view.pending_dialog = this.tabsList(threadId).find(
      (candidate) => candidate.pending_dialog,
    )?.pending_dialog;
    this.changed();
  }
  downloadsList(threadId: string): BrowserDownload[] {
    return this.view(threadId)?.downloads ?? [];
  }
  downloadAdd(threadId: string, download: BrowserDownload): void {
    const view = this.view(threadId);
    if (view && (view.downloads?.length ?? 0) < 128) {
      view.downloads = [...(view.downloads ?? []), download];
      this.changed();
    }
  }
  evaluateGrantsList(threadId: string): BrowserEvaluateGrant[] {
    return this.evaluations.get(threadId) ?? [];
  }
  evaluateGrant(threadId: string, grant: BrowserEvaluateGrant): void {
    const list = this.evaluateGrantsList(threadId);
    if (list.length >= 256) throw new Error("Evaluate grant limit");
    this.evaluations.set(threadId, [
      ...list.filter((entry) => entry.origin !== grant.origin),
      grant,
    ]);
    this.changed();
  }
  evaluateRevoke(threadId: string, origin: string): void {
    this.evaluations.set(
      threadId,
      this.evaluateGrantsList(threadId).filter((entry) => entry.origin !== origin),
    );
    this.changed();
  }
  private updateTab(entry: Entry): void {
    const tab = entry.view?.tabs?.find((candidate) => candidate.tabId === entry.view?.activeTabId);
    if (tab && entry.view) tab.url = entry.view.url;
  }
  close(threadId: string): void {
    this.originsClearPage(threadId);
    const entry = this.entries.get(threadId);
    for (const tab of entry?.view?.tabs ?? []) this.history.remove(tab.tabId);
    if (entry?.view) entry.view = { ...entry.view, closed: true, controller: "none" };
    this.privateLifecycle?.(threadId, false);
    this.changed();
  }
  unforward(threadId: string, port: number): void {
    const entry = this.entries.get(threadId);
    if (entry) entry.servers = entry.servers.filter((server) => server.port !== port);
    this.changed();
  }
  private control(threadId: string, controller: "agent" | "human", owner?: string): void {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("no_browser");
    const { owner: _previous, ...view } = entry.view;
    entry.view = { ...view, controller, ...(owner ? { owner } : {}) };
    this.changed();
  }
  private paint(entry: Entry, typed: string): void {
    entry.typed = typed;
    const { width, height } = entry.viewport;
    entry.frame = {
      sequence: (entry.frame?.sequence ?? 0) + 1,
      src:
        entry.page === "pair"
          ? pairPhoneFrame(typed, width, height)
          : sitePage(entry.view?.url ?? "about:blank", width, height),
      width,
      height,
    };
    this.changed();
  }
  private entry(threadId: string): Entry {
    let entry = this.entries.get(threadId);
    if (!entry) {
      if (this.entries.size >= 64) throw new Error("browser_limit");
      entry = {
        generation: 0,
        servers: [],
        typed: "",
        viewport: { width: 760, height: 900 },
        page: "pair",
      };
      this.entries.set(threadId, entry);
    }
    return entry;
  }
  private changed(): void {
    this.revision++;
    for (const watcher of this.watchers) watcher();
  }
}
