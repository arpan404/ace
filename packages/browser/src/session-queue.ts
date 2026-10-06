import type { BrowserCommand, BrowserDialog } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";

const inputActions = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "emulate",
  "tabs",
  "upload",
  "dialog",
  "hover",
  "drag",
  "select",
  "check",
  "uncheck",
  "focus",
  "record_start",
  "record_stop",
]);
export function mutatesBrowser(command: BrowserCommand): boolean {
  return (
    inputActions.has(command.action) && !(command.action === "tabs" && command.operation === "list")
  );
}
/** One bounded queue; dialog answers deliberately bypass renderer work. */
export class SessionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private dialogWaiters = new Set<() => void>();
  private dialogWork: Promise<void> | undefined;
  private dialog: () => BrowserDialog | undefined;
  constructor(dialog: () => BrowserDialog | undefined) {
    this.dialog = dialog;
  }
  settled(): Promise<unknown> {
    return this.tail;
  }
  changed(): void {
    if (this.dialog()) for (const notify of this.dialogWaiters) notify();
  }
  async drainDialog(): Promise<void> {
    await this.dialogWork;
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 32) return Promise.reject(new BrowserActionError("queue_full"));
    this.pending++;
    const result = this.tail.then(work);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  /** Dialogs pause renderer replies; return their state so the next tool can answer. */
  async untilDialog(run: () => Promise<unknown>): Promise<unknown> {
    let notify: (() => void) | undefined;
    const dialog = new Promise<unknown>((resolve) => {
      notify = () => {
        const pending_dialog = this.dialog();
        if (pending_dialog) resolve({ pending_dialog });
      };
      this.dialogWaiters.add(notify);
    });
    const work = run();
    const settled = work.then(
      () => {},
      () => {},
    );
    this.dialogWork = settled;
    void settled.then(() => {
      if (this.dialogWork === settled) this.dialogWork = undefined;
    });
    notify?.();
    try {
      return await Promise.race([work, dialog]);
    } finally {
      if (notify) this.dialogWaiters.delete(notify);
    }
  }
}
