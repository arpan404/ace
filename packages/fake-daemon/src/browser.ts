import type { BrowserInput } from "@ace/protocol";
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
  generation: number;
  view?: BrowserView;
  frame?: ScreenFrame;
  servers: PreviewServer[];
  typed: string;
  /** The page's viewport in CSS pixels; a real browser starts at 760x900 here too. */
  viewport: { width: number; height: number };
}

/** BrowserCommand `resize` bounds in `@ace/protocol`. */
const clampDimension = (value: number) => Math.min(4096, Math.max(100, Math.round(value)));

export class FakeBrowser {
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
  async takeover(threadId: string): Promise<void> {
    this.control(threadId, "human");
  }
  async handback(threadId: string): Promise<void> {
    this.control(threadId, "agent");
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
  /** Scripting: an agent opens the browser on a page and starts typing into it. */
  drive(threadId: string, options: { url: string; typed?: string }): void {
    const entry = this.entry(threadId);
    if (!entry.view || entry.view.closed) entry.generation++;
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
    if (entry.servers.length >= 64 && !entry.servers.some((s) => s.port === server.port))
      throw new Error("preview_limit");
    entry.servers = [...entry.servers.filter((s) => s.port !== server.port), server];
    this.changed();
  }
  close(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (entry?.view) entry.view = { ...entry.view, closed: true, controller: "none" };
    this.changed();
  }
  unforward(threadId: string, port: number): void {
    const entry = this.entries.get(threadId);
    if (entry) entry.servers = entry.servers.filter((server) => server.port !== port);
    this.changed();
  }
  private control(threadId: string, controller: "agent" | "human"): void {
    const entry = this.entries.get(threadId);
    if (!entry?.view || entry.view.closed) throw new Error("no_browser");
    entry.view = { ...entry.view, controller };
    this.changed();
  }
  private paint(entry: Entry, typed: string): void {
    entry.typed = typed;
    const { width, height } = entry.viewport;
    entry.frame = {
      sequence: (entry.frame?.sequence ?? 0) + 1,
      src: pairPhoneFrame(typed, width, height),
      width,
      height,
    };
    this.changed();
  }
  private entry(threadId: string): Entry {
    let entry = this.entries.get(threadId);
    if (!entry) {
      if (this.entries.size >= 64) throw new Error("browser_limit");
      entry = { generation: 0, servers: [], typed: "", viewport: { width: 760, height: 900 } };
      this.entries.set(threadId, entry);
    }
    return entry;
  }
  private changed(): void {
    this.revision++;
    for (const watcher of this.watchers) watcher();
  }
}
