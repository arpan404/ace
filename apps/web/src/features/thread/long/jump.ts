import type { ClientApi, ThreadSource } from "@ace/client";
import { windowSource } from "@ace/client-react";
import { meetsTail, windowCapacity, type JumpWindow } from "@ace/ui-core";
import type { JumpController, JumpSnapshot, LiveTail } from "./jump-controller.ts";

/*
 * The thread view's jumps, with the window machinery loaded on demand (ADR 0056): until the
 * reader leaves live or jumps (or the browser is idle and warms it), the transcript shows only
 * the live tail. A local reader window works even while that code loads.
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
  private retained: JumpSnapshot | undefined;
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
  snapshot = (): JumpSnapshot => this.controller?.snapshot() ?? this.retained ?? atLive;

  private start(): Promise<JumpController> {
    this.starting ??= this.load().then((loaded) => {
      const controller = new loaded.JumpController(this.client, this.threadId);
      if (this.tail) controller.setTail(this.tail);
      if (this.retained?.window) controller.retain(this.retained.window);
      this.retained = undefined;
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
  /** Keep the reader's current bounded window before the rolling live tail can evict it. */
  retain(store: ThreadSource): void {
    if (this.snapshot().window || !store.order.length) return;
    const ids = store.order.slice(-windowCapacity);
    const seqs = new Map<string, number>();
    const items = [];
    for (const id of ids) {
      const item = store.item(id);
      const seq = store.itemSequence?.(id);
      // Old clients without creation cursors cannot safely construct a pageable window.
      if (!item || seq === undefined) return;
      items.push(item);
      seqs.set(id, seq);
    }
    const window: JumpWindow = {
      items,
      seqs,
      before:
        ids.length < store.order.length
          ? (seqs.get(ids[0] ?? "") ?? null)
          : (store.itemsBefore ?? null),
      after: null,
      targetId: undefined,
    };
    if (this.controller) this.controller.retain(window);
    else {
      this.retained = { ...atLive, window, joined: true };
      for (const listener of this.listeners) listener();
      void this.start().catch(() => {
        if (!this.retained) return;
        this.retained = { ...this.retained, failed: "Couldn't load history navigation." };
        for (const listener of this.listeners) listener();
      });
    }
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
    return this.run((controller) => controller.older());
  }
  newer(): Promise<void> {
    return this.run((controller) => controller.newer());
  }
  live(): void {
    ++this.revision;
    this.retained = undefined;
    this.retainedWindow = undefined;
    this.deleted.clear();
    this.controller?.live();
  }
  tailMoved(): void {
    if (this.retained?.window && this.retained.joined && this.tail) {
      if (!meetsTail(this.retained.window, this.tail())) {
        this.retained = { ...this.retained, joined: false };
        for (const listener of this.listeners) listener();
      }
    }
    this.controller?.tailMoved();
  }
  dismissError(): void {
    this.controller?.dismissError();
  }
  /** The thread through the retained or fetched history window. */
  source(store: ThreadSource, window: JumpWindow, joined: boolean): ThreadSource | undefined {
    if (this.retainedWindow !== window) {
      const retained = new Set<string>(window.items.map((item) => item.id));
      this.deleted = new Set([...this.deleted].filter((id) => retained.has(id)));
      this.retainedWindow = window;
    }
    return windowSource(store, {
      items: window.items,
      itemSeqs: window.seqs,
      before: window.before,
      joined,
      deleted: this.deleted,
    });
  }
  /** Cancel what is in flight (the thread view unmounting; StrictMode remounts it after). */
  dispose(): void {
    ++this.revision;
    this.retained = undefined;
    this.controller?.dispose();
  }
}
