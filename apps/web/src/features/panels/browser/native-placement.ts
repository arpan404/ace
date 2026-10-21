import type { NativeViewPlacement, DesktopBrowserViews } from "@/boot/desktop-browser.ts";

/**
 * The placer that last asked to show each view. Another one may take a view over as the first
 * lets go in the same commit (a Browser tab remounting): the one letting
 * go then leaves it where it is instead of hiding it, so the view never blinks.
 */
const showing = new Map<string, NativePlacement>();
/** A view's key: the thread's shown tab, or one tab of it (split view). */
const viewKey = (placement: { threadId: string; tabId?: string | undefined }) =>
  placement.tabId === undefined
    ? placement.threadId
    : `${placement.threadId}\u0000${placement.tabId}`;

/** Own pending IPC receipts and bounded retries independently of React render lifetimes. */
export class NativePlacement {
  private readonly ports: {
    place: DesktopBrowserViews["place"];
    changed(shown: boolean): void;
    after(ms: number, run: () => void): () => void;
  };
  private alive = true;
  private key = "";
  private generation = 0;
  private retries = 0;
  private cancelRetry: (() => void) | undefined;
  private requested: NativeViewPlacement | undefined;
  private acknowledged = false;
  private superseded = false;

  constructor(ports: NativePlacement["ports"]) {
    this.ports = ports;
  }

  place(next: NativeViewPlacement): void {
    if (!this.alive) return;
    const key = JSON.stringify(next);
    if (key === this.key) return;
    if (this.key && key !== this.key) this.retries = 0;
    this.key = key;
    const generation = ++this.generation;
    const previous = this.requested;
    const retain =
      this.acknowledged &&
      previous?.visible &&
      next.visible &&
      previous.threadId === next.threadId &&
      previous.tabId === next.tabId &&
      previous.bounds.width === next.bounds.width &&
      previous.bounds.height === next.bounds.height &&
      JSON.stringify(previous.device) === JSON.stringify(next.device);
    this.requested = next;
    if (next.visible) showing.set(viewKey(next), this);
    else if (showing.get(viewKey(next)) === this) showing.delete(viewKey(next));
    this.acknowledged = !!retain;
    this.superseded = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    if (!retain) this.ports.changed(false);
    const failed = () => {
      if (!this.alive || this.generation !== generation) return;
      this.ports.changed(false);
      if (!next.visible || this.retries >= 3) return;
      this.cancelRetry = this.ports.after(250 * 2 ** this.retries, () => {
        this.cancelRetry = undefined;
        if (!this.alive || this.generation !== generation) return;
        this.retries++;
        this.key = "";
        this.place(next);
      });
    };
    void this.ports.place(next).then((receipt) => {
      if (!this.alive || this.generation !== generation) return;
      this.acknowledged = receipt === "shown";
      this.superseded = receipt === "superseded";
      if (next.visible && receipt === "unavailable") failed();
      else this.ports.changed(next.visible && this.acknowledged);
    }, failed);
  }

  visibility(threadId: string, visible: boolean, tabId?: string): void {
    if (!this.alive || this.requested?.threadId !== threadId) return;
    if (this.requested.tabId !== tabId) return;
    // Main restores retained claims only after the other window closes and metrics settle.
    if (this.superseded && this.requested.visible && visible) {
      this.acknowledged = true;
      this.superseded = false;
    }
    this.ports.changed(this.acknowledged && this.requested.visible && visible);
  }

  close(): void {
    this.alive = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.ports.changed(false);
    const requested = this.requested;
    if (!requested) return;
    const { threadId, tabId, bounds } = requested;
    const key = viewKey(requested);
    // Hidden once whatever replaces this in the same commit has had its say.
    queueMicrotask(() => {
      const current = showing.get(key);
      if (current && current !== this) return;
      showing.delete(key);
      void this.ports
        .place({ threadId, ...(tabId === undefined ? {} : { tabId }), bounds, visible: false })
        .catch(() => {});
    });
  }
}

export function placementTimer(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}
