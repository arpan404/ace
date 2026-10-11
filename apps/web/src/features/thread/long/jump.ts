import type { ClientApi, ThreadSource } from "@ace/client";
import type { JumpWindow } from "@ace/ui-core";
import type { JumpController, JumpSnapshot, LiveTail } from "./jump-controller.ts";

/*
 * The thread view's jumps, with the window machinery loaded on demand (ADR 0056): until the
 * reader first jumps (or the browser is idle and warms it), the transcript shows only the live
 * tail and needs none of it. Same surface as `JumpController`, which does the work.
 */

type Loaded = typeof import("./jump-controller.ts");
let loading: Promise<Loaded> | undefined;
/** Load the jump code; the thread screen warms it once idle. */
export const preloadJump = (): Promise<Loaded> => (loading ??= import("./jump-controller.ts"));

const atLive: JumpSnapshot = {
  window: undefined,
  joined: false,
  turn: undefined,
  loading: undefined,
  failed: undefined,
  focus: undefined,
  turns: undefined,
};

export class Jump {
  private controller: JumpController | undefined;
  private loaded: Loaded | undefined;
  private starting: Promise<JumpController> | undefined;
  private listeners = new Set<() => void>();
  private tail: (() => LiveTail) | undefined;
  private client: ClientApi;
  private threadId: string;
  private retainedWindow: JumpWindow | undefined;
  private deleted = new Set<string>();
  private revision = 0;
  private load: () => Promise<Loaded>;
  constructor(client: ClientApi, threadId: string, load: () => Promise<Loaded> = preloadJump) {
    this.client = client;
    this.threadId = threadId;
    this.load = load;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): JumpSnapshot => this.controller?.snapshot() ?? atLive;

  private start(): Promise<JumpController> {
    this.starting ??= this.load().then((loaded) => {
      this.loaded = loaded;
      const controller = new loaded.JumpController(this.client, this.threadId);
      if (this.tail) controller.setTail(this.tail);
      controller.subscribe(() => {
        for (const listener of this.listeners) listener();
      });
      this.controller = controller;
      return controller;
    });
    return this.starting;
  }
  private async run(action: (controller: JumpController) => Promise<void>): Promise<void> {
    const revision = ++this.revision;
    const controller = await this.start();
    if (revision === this.revision) await action(controller);
  }

  setTail(tail: () => LiveTail): void {
    this.tail = tail;
    this.controller?.setTail(tail);
  }
  toTurn(ordinal: number): Promise<void> {
    return this.run((controller) => controller.toTurn(ordinal));
  }
  toSeq(seq: number, options: { turn?: number | null; query?: string } = {}): Promise<void> {
    return this.run((controller) => controller.toSeq(seq, options));
  }
  toItem(itemId: string): Promise<void> {
    return this.run((controller) => controller.toItem(itemId));
  }
  older(): Promise<void> {
    return this.controller?.older() ?? Promise.resolve();
  }
  newer(): Promise<void> {
    return this.controller?.newer() ?? Promise.resolve();
  }
  live(): void {
    ++this.revision;
    this.retainedWindow = undefined;
    this.deleted.clear();
    this.controller?.live();
  }
  tailMoved(): void {
    this.controller?.tailMoved();
  }
  dismissError(): void {
    this.controller?.dismissError();
  }
  /** The thread through `window`; a window only exists once the jump code has loaded. */
  source(store: ThreadSource, window: JumpWindow, joined: boolean): ThreadSource | undefined {
    if (this.retainedWindow !== window) {
      const retained = new Set<string>(window.items.map((item) => item.id));
      this.deleted = new Set([...this.deleted].filter((id) => retained.has(id)));
      this.retainedWindow = window;
    }
    return this.loaded?.jumpedSource(store, window, joined, this.deleted);
  }
  /** Cancel what is in flight (the thread view unmounting; StrictMode remounts it after). */
  dispose(): void {
    ++this.revision;
    this.controller?.dispose();
  }
}
