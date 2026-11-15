import { z } from "zod";

const TargetWindow = z.object({ windowId: z.number().int() });

/** Sends one CDP command to a tab's page. */
export type RestSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/**
 * Whether one headless tab's page is hidden (ADR 0083, rest). Resting turns focus emulation off
 * and minimizes the window: a hidden page draws nothing, while focus emulation alone keeps a
 * minimized page drawing. Showing undoes both. Each step's applied state is tracked on its own,
 * so a change that failed half way is finished by the next one. Changes apply one at a time in
 * the order asked, and every call waits for those asked before it, even one that changes
 * nothing: nothing runs against a page that is still being hidden or shown.
 */
export class WindowRest {
  private send: RestSend;
  /** The state last asked for. */
  private wanted = false;
  private minimized = false;
  private unfocused = false;
  private queue: Promise<void> = Promise.resolve();
  private retired = false;
  constructor(send: RestSend) {
    this.send = send;
  }
  /** Hidden or about to be, or still partly hidden after a show that failed. */
  get resting(): boolean {
    return this.wanted || this.minimized || this.unfocused;
  }
  /** Hide (`true`) or show the page; resolves once this and every earlier change applied. */
  set(resting: boolean): Promise<void> {
    this.wanted = resting;
    const run = this.queue.then(() => this.apply(resting));
    this.queue = run.catch(() => {});
    return run;
  }
  /** The tab moved to another page (a new target, in a new shown window): stop touching it. */
  retire(): void {
    this.retired = true;
  }
  private async apply(resting: boolean): Promise<void> {
    // A later call asked otherwise, and applies after this one.
    if (this.retired || this.wanted !== resting) return;
    if (resting) {
      if (!this.unfocused) {
        await this.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        if (this.retired) return;
        this.unfocused = true;
      }
      if (!this.minimized) {
        await this.windowState("minimized");
        if (this.retired) return;
        this.minimized = true;
      }
      return;
    }
    if (this.minimized) {
      await this.windowState("normal");
      if (this.retired) return;
      this.minimized = false;
    }
    if (this.unfocused) {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (this.retired) return;
      this.unfocused = false;
    }
  }
  private async windowState(windowState: "minimized" | "normal"): Promise<void> {
    const { windowId } = TargetWindow.parse(await this.send("Browser.getWindowForTarget"));
    await this.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
  }
}
