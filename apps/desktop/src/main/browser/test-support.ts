import type { BrowserOpen } from "@ace/protocol";
import type { ViewHost, ViewPage } from "./backend.ts";

/** An embedded view without Electron: records CDP and lets tests emit events or input. */
export class FakePage implements ViewPage {
  address = "about:blank";
  calls: { method: string; params: Record<string, unknown> }[] = [];
  nativeInput = false;
  closed = false;
  /** CDP results by method; the default is `{}`. */
  results = new Map<string, unknown>([["Page.captureScreenshot", { data: "AA==" }]]);
  private events = new Set<(method: string, params: unknown) => void>();
  private blocked = new Set<() => void>();
  private navigationSequence = 0;

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    // As Electron's debugger does once its WebContents is destroyed.
    if (this.closed) throw new Error("Browser view closed");
    this.calls.push({ method, params: params ?? {} });
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
  onBlockedInput(listener: () => void): () => void {
    this.blocked.add(listener);
    return () => this.blocked.delete(listener);
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
  url(): string {
    return this.address;
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.events) listener(method, params);
  }
  /** The person clicks in the view; the view reports it only while native input is off. */
  personClicks(): void {
    if (this.nativeInput) return;
    for (const listener of this.blocked) listener();
  }
  acks(): number {
    return this.calls.filter((call) => call.method === "Page.screencastFrameAck").length;
  }
}

export function fakeViews() {
  const pages = new Map<string, FakePage>();
  const opened: BrowserOpen[] = [];
  const purged: { threadId: string; workspaceId: string }[] = [];
  let purgeError: string | undefined;
  const host: ViewHost = {
    async purge(request) {
      if (purgeError) throw new Error(purgeError);
      purged.push(request);
    },
    async open(request) {
      const page = new FakePage();
      pages.set(request.sessionId, page);
      opened.push(request.options);
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
  return { host, pages, opened, purged, failPurge, only };
}

/** A CDP screencast frame as Chromium sends it. */
export function screencastFrame(frameId: number, data: string) {
  return { sessionId: frameId, data, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
}
