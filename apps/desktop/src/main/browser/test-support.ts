import type { BrowserOpen } from "@ace/protocol";
import type { ViewHost, ViewPage } from "./backend.ts";
import { EmbeddedPageGroup } from "./page-group.ts";

/** An embedded view without Electron: records CDP and lets tests emit events or input. */
export class FakePage implements ViewPage {
  address = "about:blank";
  calls: { method: string; params: Record<string, unknown> }[] = [];
  nativeInput = false;
  closed = false;
  /** CDP results by method; the default is `{}`. */
  results = new Map<string, unknown>([["Page.captureScreenshot", { data: "AA==" }]]);
  /** CDP methods that never answer, as a page stuck in a long task. */
  hung = new Set<string>();
  /** CDP methods that wait for the test to release them, as a page busy for a while. */
  private held = new Map<string, Promise<void>>();
  /** The daemon link dropped while this page lived (`orphan`), and adoptions since. */
  orphaned = false;
  adoptions = 0;
  private events = new Set<(method: string, params: unknown) => void>();
  private humanInput = new Set<(tabId?: string) => void>();
  agentControl = false;
  private navigationSequence = 0;

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // As Electron's debugger does once its WebContents is destroyed.
    if (this.closed) throw new Error("Browser view closed");
    this.calls.push({ method, params: params ?? {} });
    if (this.hung.has(method) || this.hung.has("*")) return new Promise(() => {});
    await this.held.get(method);
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main", url: this.address } } };
    if (method === "Page.navigate") {
      if (typeof params?.url !== "string") throw new Error("Navigation URL required");
      this.address = params.url;
      const loaderId = `loader-${++this.navigationSequence}`;
      this.emit("Page.frameNavigated", { frame: { id: "main", url: this.address, loaderId } });
      this.emit("Page.lifecycleEvent", { frameId: "main", loaderId, name: "DOMContentLoaded" });
      return { frameId: "main", loaderId };
    }
    return this.results.get(method) ?? {};
  }
  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onHumanInput(listener: (tabId?: string) => void): () => void {
    this.humanInput.add(listener);
    return () => this.humanInput.delete(listener);
  }
  async navigate(url: string): Promise<string> {
    this.address = url;
    return url;
  }
  async press(key: string): Promise<void> {
    this.calls.push({ method: "press", params: { key } });
  }
  async resize(width: number, height: number): Promise<void> {
    this.calls.push({ method: "resize", params: { width, height } });
  }
  setNativeInput(enabled: boolean): void {
    this.nativeInput = enabled;
  }
  setAgentControl(agent: boolean): void {
    this.agentControl = agent;
  }
  url(): string {
    return this.address;
  }
  orphan(): void {
    this.orphaned = true;
  }
  async readopt(): Promise<void> {
    if (this.closed) throw new Error("Browser view closed");
    this.orphaned = false;
    this.adoptions++;
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  /** `method` answers only once the returned release runs. */
  hold(method: string): () => void {
    const gate = Promise.withResolvers<void>();
    this.held.set(method, gate.promise);
    return () => {
      this.held.delete(method);
      gate.resolve();
    };
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.events) listener(method, params);
  }
  /** The person clicks in the view, which reports it while it takes their input. */
  personClicks(): void {
    if (!this.nativeInput) return;
    for (const listener of this.humanInput) listener();
  }
  acks(): number {
    return this.calls.filter((call) => call.method === "Page.screencastFrameAck").length;
  }
}

export function fakeViews() {
  const pages = new Map<string, FakePage>();
  const opened: BrowserOpen[] = [];
  const purged: { threadId: string; workspaceId: string }[] = [];
  const purgedProjects: string[] = [];
  /** The profile scope each view opened with, by session. */
  const scopes = new Map<string, string | undefined>();
  let purgeError: string | undefined;
  const host: ViewHost = {
    async purge(request) {
      if (purgeError) throw new Error(purgeError);
      purged.push(request);
    },
    async purgeProject(request) {
      if (purgeError) throw new Error(purgeError);
      purgedProjects.push(request.workspaceId);
    },
    async open(request) {
      const page = new FakePage();
      pages.set(request.sessionId, page);
      opened.push(request.options);
      scopes.set(request.sessionId, request.profileScope);
      return page;
    },
  };
  const only = (): FakePage => {
    const [page] = pages.values();
    if (!page || pages.size !== 1) throw new Error(`Expected one view, found ${pages.size}`);
    return page;
  };
  const failPurge = (message: string) => {
    purgeError = message;
  };
  return { host, pages, opened, purged, purgedProjects, scopes, failPurge, only };
}

/** A CDP screencast frame as Chromium sends it. */
export function screencastFrame(frameId: number, data: string) {
  return { sessionId: frameId, data, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
}

/** One native tab's view: where its group last placed it and whether an agent uses it. */
export class TabPage extends FakePage {
  shown = false;
  /** Hidden only while the app's menu covers it. */
  covered = false;
  agent = true;
  async picture() {
    return this.shown ? "data:image/png;base64,AA==" : undefined;
  }
  viewport() {
    return { width: 800, height: 600 };
  }
  place(target: { visible: boolean; covered?: boolean }) {
    this.shown = target.visible;
    this.covered = target.covered === true;
  }
  async placementReady() {}
  isShown() {
    return this.shown;
  }
  override setAgentControl(agent: boolean) {
    this.agent = agent;
  }
}

/** Views as the desktop makes them: each thread a page group that starts with one tab. */
export function groupViews() {
  const tabs = new Map<string, TabPage>();
  const host: ViewHost = {
    async open() {
      const group = new EmbeddedPageGroup(
        async (id) => {
          const page = new TabPage();
          tabs.set(id, page);
          return page;
        },
        async () => {},
      );
      await group.openTab();
      return group;
    },
  };
  const tab = (id: string): TabPage => {
    const page = tabs.get(id);
    if (!page) throw new Error(`No native tab ${id}`);
    return page;
  };
  return { host, tabs, tab };
}
