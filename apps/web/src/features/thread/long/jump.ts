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
  constructor(client: ClientApi, threadId: string) {
    this.client = client;
    this.threadId = threadId;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (): JumpSnapshot => this.controller?.snapshot() ?? atLive;

  private start(): Promise<JumpController> {
    this.starting ??= preloadJump().then((loaded) => {
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
    await action(await this.start());
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
  older(): Promise<void> {
    return this.controller?.older() ?? Promise.resolve();
  }
  newer(): Promise<void> {
    return this.controller?.newer() ?? Promise.resolve();
  }
  live(): void {
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
    return this.loaded?.jumpedSource(store, window, joined);
  }
  /** Cancel what is in flight (the thread view unmounting; StrictMode remounts it after). */
  dispose(): void {
    this.controller?.dispose();
  }
}
