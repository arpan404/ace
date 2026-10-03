import { pairPhoneFrame } from "./preview-page.ts";

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
  | { kind: "mouse"; event: "mousePressed" | "mouseReleased"; x: number; y: number }
  | { kind: "key"; event: "keyDown"; key: string; text?: string };

interface Entry {
  view?: BrowserView;
  frame?: ScreenFrame;
  servers: PreviewServer[];
}

export class FakeBrowser {
  private entries = new Map<string, Entry>();
  private watchers = new Set<() => void>();
  private revision = 0;
  readonly available = true;
  /** Input forwarded while a person had control: what the daemon received. */
  readonly inputs: { threadId: string; input: ForwardedInput }[] = [];
  get version(): number {
    return this.revision;
  }
  subscribe(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
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
  async takeover(threadId: string): Promise<void> {
    this.control(threadId, "human");
  }
  async handback(threadId: string): Promise<void> {
    this.control(threadId, "agent");
  }
  input(threadId: string, input: ForwardedInput): void {
    if (this.view(threadId)?.controller !== "human") return;
    this.inputs.push({ threadId, input });
  }
  /** Scripting: an agent opens the browser on a page and starts typing into it. */
  drive(threadId: string, options: { url: string; typed?: string }): void {
    const entry = this.entry(threadId);
    entry.view = { threadId, controller: "agent", url: options.url, closed: false };
    this.paint(entry, options.typed ?? "");
  }
  /** Scripting: the agent types more of the device name (ignored while a person has control). */
  type(threadId: string, typed: string): void {
    const entry = this.entries.get(threadId);
    if (entry?.view?.controller === "agent") this.paint(entry, typed);
  }
  /** Scripting: the preview gateway detected a dev server for this thread. */
  serve(threadId: string, server: PreviewServer): void {
    const entry = this.entry(threadId);
    entry.servers = [...entry.servers.filter((s) => s.port !== server.port), server];
    this.changed();
  }
  private control(threadId: string, controller: "agent" | "human"): void {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("no_browser");
    entry.view = { ...entry.view, controller };
    this.changed();
  }
  private paint(entry: Entry, typed: string): void {
    entry.frame = {
      sequence: (entry.frame?.sequence ?? 0) + 1,
      src: pairPhoneFrame(typed),
      width: 760,
      height: 900,
    };
    this.changed();
  }
  private entry(threadId: string): Entry {
    let entry = this.entries.get(threadId);
    if (!entry) {
      entry = { servers: [] };
      this.entries.set(threadId, entry);
    }
    return entry;
  }
  private changed(): void {
    this.revision++;
    for (const watcher of this.watchers) watcher();
  }
}
