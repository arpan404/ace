import { BrowserOriginError, browserOrigin } from "@ace/browser/policy";
import type {
  BrowserInput,
  BrowserTab,
  BrowserTabActor,
  BrowserDownload,
  BrowserDialog,
} from "@ace/protocol";
import { BrowserDocumentHistory } from "./browser-history.ts";
import { FakeAnnotations } from "./browser-annotation.ts";
import { FakeBrowserLogs } from "./browser-logs.ts";
import { pairPhoneFrame, sitePage } from "./preview-page.ts";

/**
 * The browser and preview services (ADR 0008, 0009, 0083) as a client sees them, simulated in
 * memory: each thread's browser holds tabs that people and agents share (ADR 0067,
 * "Collaboration"), with a screencast frame of the tab the person views, plus the dev servers
 * the preview gateway detected. Shapes follow `BrowserState`, `BrowserFrame`, `BrowserInput`
 * and `PreviewDescriptor` in `@ace/protocol`.
 */
export interface BrowserView {
  threadId: string;
  url: string;
  closed: boolean;
  /** Where the page runs: the desktop app's embedded view, or the daemon's headless Chromium. */
  backend?: "embedded" | "headless";
  status?: "ready" | "paused" | "recovering";
  pageStateLost?: boolean;
  tabs?: BrowserTab[];
  activeTabId?: string;
  downloads?: BrowserDownload[];
  pending_dialog?: BrowserDialog | undefined;
  loading?: boolean;
  /** The shown page's load failure, as Chromium names it (`net::ERR_…`). */
  loadError?: string;
  reason?: string;
  /** Page features this fixture supports (BrowserState.features). */
  features?: string[];
  /** The connection with annotate mode open (ADR 0082). */
  annotation?: { owner: string };
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

/** What one tab draws: the seeded pairing page with what an agent typed, or any other site. */
interface Page {
  page: "pair" | "site";
  typed: string;
}
interface Entry {
  generation: number;
  view?: BrowserView;
  frame?: ScreenFrame;
  servers: PreviewServer[];
  pages: Map<string, Page>;
  /** The person picked the tab they view: an agent's new tab no longer takes the view. */
  picked: boolean;
  /** The page's viewport in CSS pixels; a real browser starts at 760x900 here too. */
  viewport: { width: number; height: number };
}

/** BrowserCommand `resize` bounds in `@ace/protocol`. */
const clampDimension = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));
const local = (hostname: string) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(hostname);

export class FakeBrowser {
  private history = new BrowserDocumentHistory();
  private tabSequence = 0;
  private entries = new Map<string, Entry>();
  /** Annotate mode: `emit` and `pin` script what the page's overlay would report. */
  readonly annotations = new FakeAnnotations(
    (threadId) => this.entries.get(threadId)?.view,
    () => this.changed(),
  );
  /** Each thread's console and network log (`logs`); tests add what a page logged. */
  readonly logs = new FakeBrowserLogs();
  /** Multi-size screenshots a person took (`screenshot` with `sizes`), in order. */
  readonly sizedCaptures: { threadId: string; tabId?: string | undefined; sizes: string[] }[] = [];
  private watchers = new Set<() => void>();
  private revision = 0;
  readonly available = true;
  /**
   * The daemon's first browser needs Chromium downloaded (ADR 0055 acquisition). While set, the
   * next `browser.open` reports download progress and waits for `finishDownload()`.
   */
  private download: { total: number; done: Promise<void>; finish(): void } | undefined;
  /** The person's input, as the daemon received it. */
  readonly inputs: { threadId: string; tabId?: string; input: ForwardedInput }[] = [];
  readonly wireInputs: { threadId: string; tabId?: string; input: BrowserInput }[] = [];
  /** What a person's right click finds under the pointer (`context_target`). */
  contextTarget: { link?: string; image?: string } | undefined;
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
  /** Threads whose browser an agent is working in now (`browser.browsing`). */
  browsingThreads(): string[] {
    return [...this.entries]
      .filter(
        ([, entry]) =>
          entry.view &&
          !entry.view.closed &&
          (entry.view.tabs ?? []).some((tab) => tab.inUse?.kind === "agent"),
      )
      .map(([threadId]) => threadId);
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
  tab(threadId: string, tabId?: string): BrowserTab | undefined {
    const view = this.view(threadId);
    const id = tabId ?? view?.activeTabId;
    return view?.tabs?.find((tab) => tab.tabId === id);
  }
  /** As the daemon: any http(s) site opens without asking; a private tab refuses the agent. */
  async navigateAgent(
    threadId: string,
    url: string,
    options: { tabId?: string; agentId?: string } = {},
  ): Promise<void> {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    const tab = this.tab(threadId, options.tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    if (tab.private) throw new Error("human_private");
    if (!browserOrigin(url) || !/^https?:\/\//i.test(url))
      throw new BrowserOriginError(url, "invalid_origin", "Browser requires an HTTP(S) address");
    this.use(tab, options.agentId);
    this.load(entry, tab, new URL(url).href, "site");
  }
  /** Scripting: an agent works in a tab (its cursor at `pointer`), marking it in use. */
  agentWorks(
    threadId: string,
    options: { tabId?: string; agentId?: string; pointer?: { x: number; y: number } } = {},
  ): void {
    const tab = this.tab(threadId, options.tabId);
    if (!tab || tab.private) throw new Error("Browser tab unavailable");
    this.use(tab, options.agentId);
    if (options.pointer)
      tab.pointer = { ...options.pointer, sequence: (tab.pointer?.sequence ?? 0) + 1 };
    this.changed();
  }
  /**
   * Scripting: the page reports its own title and favicon (`document.title`, its icon), as the
   * daemon's page identity does; a navigation clears them until the next page reports.
   */
  pageIdentity(threadId: string, identity: { title: string; favicon?: string }, tabId?: string) {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.title = identity.title;
    if (identity.favicon) tab.favicon = identity.favicon;
    else delete tab.favicon;
    this.changed();
  }
  /** A tab starts or stops playing sound (the page's media). */
  mediaPlays(threadId: string, playing: boolean, tabId?: string): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) return;
    if (playing) tab.playing = true;
    else delete tab.playing;
    this.changed();
  }
  /** Scripting: the agent went idle; its mark leaves the tab. */
  agentIdle(threadId: string, tabId?: string): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) return;
    delete tab.inUse;
    delete tab.pointer;
    this.changed();
  }
  lose(threadId: string): void {
    this.annotations.end(threadId, "restart");
    const view = this.view(threadId);
    if (!view) return;
    view.status = "paused";
    view.pageStateLost = true;
    this.changed();
  }
  reopen(threadId: string): void {
    const view = this.view(threadId);
    if (!view?.pageStateLost) return;
    view.status = "ready";
    view.pageStateLost = false;
    this.changed();
  }
  disconnect(owner: string): void {
    this.annotations.disconnect(owner, this.entries.keys());
  }
  /** The person's input always lands, in whichever tab they use, whoever else works there. */
  wireInput(threadId: string, input: BrowserInput, tabId?: string): void {
    const view = this.view(threadId);
    if (!view || view.closed) throw new Error("Browser closed");
    const target = tabId ?? view.activeTabId;
    if (this.wireInputs.length >= 256) this.wireInputs.shift();
    this.wireInputs.push({ threadId, ...(target ? { tabId: target } : {}), input });
    let forwarded: ForwardedInput | undefined;
    if (
      input.kind === "mouse" &&
      (input.event === "mousePressed" || input.event === "mouseReleased")
    )
      forwarded = { kind: "mouse", event: input.event, x: input.x, y: input.y };
    if (input.kind === "key" && input.event === "keyDown")
      forwarded = {
        kind: "key",
        event: input.event,
        key: input.key,
        ...(input.text ? { text: input.text } : {}),
      };
    if (!forwarded) return;
    if (this.inputs.length >= 256) this.inputs.shift();
    this.inputs.push({ threadId, ...(target ? { tabId: target } : {}), input: forwarded });
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
    if (entry.view && !entry.view.closed) this.paint(entry);
  }
  /**
   * The person navigates a tab (the shown one unless named). A local address nothing listens on
   * fails the way Chromium reports it; so does an unsafe port.
   */
  navigate(threadId: string, url: string, tabId?: string): string {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`net::ERR_INVALID_URL at ${url}`);
    }
    const origin = browserOrigin(url);
    if (!origin || !["http:", "https:"].includes(parsed.protocol))
      throw new BrowserOriginError(url, "invalid_origin", "Browser requires an HTTP(S) address");
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if ([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25].includes(port))
      throw new Error(`net::ERR_UNSAFE_PORT at ${url}`);
    const isLocal = local(parsed.hostname);
    if (isLocal && !entry.servers.some((server) => server.port === port))
      throw new Error(`net::ERR_CONNECTION_REFUSED at ${url}`);
    if (parsed.hostname.endsWith(".invalid"))
      throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
    if (tab.tabId === entry.view.activeTabId) this.annotations.end(threadId, "navigated");
    const pair =
      isLocal && entry.servers.some((server) => server.port === port && server.name === "web");
    this.load(entry, tab, parsed.href, pair ? "pair" : "site");
    return parsed.href;
  }
  /**
   * Scripting: an agent opens the browser on a page and starts typing into it (a blank page is
   * a browser a person opened).
   */
  drive(
    threadId: string,
    options: { url: string; typed?: string; backend?: "embedded" | "headless" },
  ): void {
    const entry = this.entry(threadId);
    for (const tab of entry.view?.tabs ?? []) this.history.remove(tab.tabId);
    entry.pages.clear();
    entry.picked = false;
    if (!entry.view || entry.view.closed) entry.generation++;
    const tabId = `tab-${++this.tabSequence}`;
    entry.view = {
      threadId,
      url: options.url,
      closed: false,
      ...(options.backend ? { backend: options.backend } : {}),
      tabs: [
        {
          tabId,
          url: options.url,
          title: "Fixture page",
          openedBy: { kind: "agent" },
          ...(options.url === "about:blank" ? {} : { inUse: { kind: "agent" as const } }),
          lifecycle: "live",
        },
      ],
      activeTabId: tabId,
      downloads: [],
      status: "ready",
      features: ["annotate", "tabs", "collaborate"],
    };
    this.history.visit(tabId, options.url);
    entry.pages.set(tabId, {
      page: options.url === "about:blank" ? "site" : "pair",
      typed: options.typed ?? "",
    });
    this.paint(entry);
  }
  /** Scripting: the agent types more of the device name into the pairing page it works in. */
  type(threadId: string, typed: string, tabId?: string): void {
    const entry = this.entries.get(threadId);
    const tab = this.tab(threadId, tabId);
    const page = tab && entry?.pages.get(tab.tabId);
    if (!entry || !tab || tab.private || page?.page !== "pair") return;
    page.typed = typed;
    this.use(tab);
    this.paint(entry);
  }
  /** Set, the daemon refuses forwarding and sign-in links with this code (tests, scenarios). */
  previewRefusal: string | undefined;
  /** Refuse forwarding and sign-in links with `code` from now on, or accept them again. */
  refusePreviews(code: string | undefined): void {
    this.previewRefusal = code;
  }
  /** Scripting: the preview gateway detected a dev server for this thread. */
  serve(threadId: string, server: PreviewServer): void {
    const entry = this.entry(threadId);
    if (entry.servers.length >= 64 && !entry.servers.some((s) => s.port === server.port))
      throw new Error("preview_limit");
    entry.servers = [...entry.servers.filter((s) => s.port !== server.port), server];
    this.changed();
  }
  navigationHistory(threadId: string, tabId?: string) {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    return this.history.capabilities(tab.tabId);
  }
  navigateHistory(
    threadId: string,
    direction: "back" | "forward" | "reload" | "stop",
    tabId?: string,
  ) {
    const entry = this.entries.get(threadId);
    const view = entry?.view;
    const tab = this.tab(threadId, tabId);
    if (!entry || !view || view.closed || !tab) throw new Error("Browser closed");
    const url = this.history.move(tab.tabId, direction);
    if (url !== undefined) {
      if (tab.tabId === view.activeTabId) this.annotations.end(threadId, "navigated");
      tab.url = url;
      this.setPage(entry, tab.tabId, "site");
      if (tab.tabId === view.activeTabId) view.url = url;
      this.paint(entry);
    }
    return { ok: true };
  }
  /** A tab's zoom and emulated device, as the daemon lists them (undefined clears). */
  tabView(
    threadId: string,
    tabId: string | undefined,
    view: Partial<Pick<BrowserTab, "zoom" | "emulation">>,
  ): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    for (const key of ["zoom", "emulation"] as const)
      if (key in view) {
        if (view[key] === undefined) delete tab[key];
        else Object.assign(tab, { [key]: view[key] });
      }
    this.changed();
  }
  tabsList(threadId: string): BrowserTab[] {
    return this.view(threadId)?.tabs ?? [];
  }
  /**
   * Scripting: an agent opens a tab of its own (ADR 0083). The person's view moves to it only
   * while they have not picked a tab themselves.
   */
  tabOpen(
    threadId: string,
    url: string,
    options: { label?: string; agentId?: string } = {},
  ): string {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    const opener: BrowserTabActor = {
      kind: "agent",
      ...(options.agentId ? { agentId: options.agentId } : {}),
    };
    const tab = this.addTab(entry, url, opener, options.label);
    this.use(tab, options.agentId);
    if (!entry.picked) this.show(entry, tab.tabId);
    else this.changed();
    return tab.tabId;
  }
  /** The person opens a tab, optionally at an address; it is shown at once. */
  personOpen(threadId: string, url?: string): string {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("Browser closed");
    const tab = this.addTab(entry, "about:blank", { kind: "human" });
    entry.picked = true;
    this.show(entry, tab.tabId);
    if (url) this.navigate(threadId, url, tab.tabId);
    return tab.tabId;
  }
  /** The person picks a tab to view; agents keep working wherever they are. */
  tabSelect(threadId: string, tabId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry?.view?.tabs?.some((tab) => tab.tabId === tabId))
      throw new Error("Browser tab unavailable");
    entry.picked = true;
    this.show(entry, tabId);
  }
  /** Closing the last tab closes the browser, as in the daemon. */
  tabClose(threadId: string, tabId: string): { closed: true } | undefined {
    const entry = this.entries.get(threadId);
    const view = entry?.view;
    if (!entry || !view?.tabs?.some((tab) => tab.tabId === tabId))
      throw new Error("Browser tab unavailable");
    if (view.tabs.length === 1) {
      this.close(threadId);
      return { closed: true };
    }
    const index = view.tabs.findIndex((tab) => tab.tabId === tabId);
    view.tabs = view.tabs.filter((tab) => tab.tabId !== tabId);
    entry.pages.delete(tabId);
    this.history.remove(tabId);
    view.pending_dialog = view.tabs.find((tab) => tab.pending_dialog)?.pending_dialog;
    const next = view.tabs[Math.min(index, view.tabs.length - 1)];
    if (view.activeTabId === tabId && next) this.show(entry, next.tabId);
    else this.changed();
    return undefined;
  }
  /** "Keep agents out of this tab" (the person's choice), or let them back in. */
  setPrivate(threadId: string, tabId: string, value: boolean): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    if (value) {
      tab.private = true;
      delete tab.inUse;
      delete tab.pointer;
    } else delete tab.private;
    this.changed();
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
  /** The shown page failed to load with a Chromium net error (`net::ERR_…`). */
  loadFailed(threadId: string, error: string): void {
    const view = this.view(threadId);
    if (!view) throw new Error("Browser unavailable");
    view.loadError = error;
    view.loading = false;
    this.changed();
  }
  /** The tab's page opened its file picker. */
  fileChooserOpen(threadId: string, tabId: string, multiple: boolean): string {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    const chooserId = `${tabId}-files`;
    tab.file_chooser = { chooserId, tabId, multiple };
    this.changed();
    return chooserId;
  }
  /** What the page's input received: the picked files' names and hashes ([] for Cancel). */
  readonly chosenFiles: { sha256: string; name: string }[][] = [];
  chooseFiles(
    threadId: string,
    tabId: string,
    chooserId: string,
    files: { sha256: string; name: string }[],
  ): void {
    const tab = this.tab(threadId, tabId);
    if (tab?.file_chooser?.chooserId !== chooserId) throw new Error("File picker no longer open");
    delete tab.file_chooser;
    this.chosenFiles.push(files);
    this.changed();
  }
  /** The tab's page plays sound or stops; agents' and background tabs start muted. */
  sound(threadId: string, tabId: string, audible: boolean, muted: boolean): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.audible = audible;
    tab.muted = muted;
    this.changed();
  }
  mute(threadId: string, tabId: string, muted: boolean): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.muted = muted;
    this.changed();
  }
  /** A site on this tab asks for a sign-in; only the person's answer clears it. */
  signInAsk(threadId: string, tabId: string, realm: string): string {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    const authId = `${tabId}-auth`;
    // Fake pages may be listed as typed ("localhost:5173/settings"), without a scheme.
    const origin = new URL(tab.url.includes("://") ? tab.url : `http://${tab.url}`).origin;
    tab.pending_auth = { authId, tabId, origin, realm };
    this.changed();
    return authId;
  }
  /** What the site received: the person's credentials, or `null` for a cancelled sign-in. */
  readonly signIns: ({ username: string; password: string } | null)[] = [];
  signInAnswer(
    threadId: string,
    tabId: string,
    authId: string,
    credentials: { username: string; password: string } | undefined,
  ): void {
    const tab = this.tab(threadId, tabId);
    if (tab?.pending_auth?.authId !== authId) throw new Error("Sign-in no longer pending");
    delete tab.pending_auth;
    this.signIns.push(credentials ?? null);
    this.changed();
  }
  /** The tab's page failed on an untrusted certificate for `url`. */
  certificateFail(threadId: string, tabId: string, url: string, error: string): void {
    const tab = this.tab(threadId, tabId);
    if (!tab) throw new Error("Browser tab unavailable");
    tab.certificate_error = { url, error };
    this.changed();
  }
  /** The person proceeded past the certificate error for `url`; the page loads. */
  certificateProceed(threadId: string, tabId: string, url: string): void {
    const tab = this.tab(threadId, tabId);
    if (tab?.certificate_error?.url !== url) throw new Error("Certificate error no longer shown");
    delete tab.certificate_error;
    tab.url = url;
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
  close(threadId: string): void {
    this.annotations.end(threadId, "stopped");
    const entry = this.entries.get(threadId);
    for (const tab of entry?.view?.tabs ?? []) this.history.remove(tab.tabId);
    if (entry?.view) entry.view = { ...entry.view, closed: true };
    this.changed();
  }
  unforward(threadId: string, port: number): void {
    const entry = this.entries.get(threadId);
    if (entry) entry.servers = entry.servers.filter((server) => server.port !== port);
    this.changed();
  }
  private use(tab: BrowserTab, agentId?: string): void {
    const actor: BrowserTabActor = { kind: "agent", ...(agentId ? { agentId } : {}) };
    tab.inUse = actor;
    tab.drivenBy = actor;
  }
  private addTab(entry: Entry, url: string, opener: BrowserTabActor, label?: string) {
    const view = entry.view;
    if (!view) throw new Error("Browser closed");
    const tab: BrowserTab = {
      tabId: `tab-${++this.tabSequence}`,
      url,
      title: url === "about:blank" ? "New tab" : "Fixture page",
      openedBy: opener,
      ...(label ? { label } : {}),
      lifecycle: "live",
    };
    view.tabs = [...(view.tabs ?? []), tab];
    this.history.visit(tab.tabId, url);
    entry.pages.set(tab.tabId, { page: "site", typed: "" });
    return tab;
  }
  private show(entry: Entry, tabId: string): void {
    const view = entry.view;
    const tab = view?.tabs?.find((candidate) => candidate.tabId === tabId);
    if (!view || !tab) return;
    if (view.activeTabId !== tabId) this.annotations.end(view.threadId, "tab");
    view.activeTabId = tabId;
    view.url = tab.url;
    this.paint(entry);
  }
  private load(entry: Entry, tab: BrowserTab, url: string, page: Page["page"]): void {
    tab.url = url;
    tab.title = "Fixture page";
    delete tab.favicon;
    this.history.visit(tab.tabId, url);
    this.setPage(entry, tab.tabId, page);
    if (entry.view && tab.tabId === entry.view.activeTabId) {
      entry.view.url = url;
      this.paint(entry);
    } else this.changed();
  }
  private setPage(entry: Entry, tabId: string, page: Page["page"]): void {
    const current = entry.pages.get(tabId);
    entry.pages.set(tabId, { page, typed: current?.page === page ? current.typed : "" });
  }
  private paint(entry: Entry): void {
    const { width, height } = entry.viewport;
    const active = entry.view?.activeTabId;
    const page = (active && entry.pages.get(active)) || { page: "site", typed: "" };
    entry.frame = {
      sequence: (entry.frame?.sequence ?? 0) + 1,
      src:
        page.page === "pair"
          ? pairPhoneFrame(page.typed, width, height)
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
        pages: new Map(),
        picked: false,
        viewport: { width: 760, height: 900 },
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
