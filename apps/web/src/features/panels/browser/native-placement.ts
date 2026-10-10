import type { NativeViewPlacement, DesktopBrowserViews } from "@/boot/desktop-browser.ts";

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
    this.requested = next;
    this.acknowledged = false;
    this.superseded = false;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.ports.changed(false);
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

  visibility(threadId: string, visible: boolean): void {
    if (!this.alive || this.requested?.threadId !== threadId) return;
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
    if (this.requested)
      void this.ports
        .place({ threadId: this.requested.threadId, bounds: this.requested.bounds, visible: false })
        .catch(() => {});
  }
}

export function placementTimer(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}
