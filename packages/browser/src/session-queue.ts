import type { BrowserCommand } from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";

const inputActions = new Set([
  "history",
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "emulate",
  "tabs",
  "fill_form",
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
  "annotate",
  "annotate_capture",
]);
export function mutatesBrowser(command: BrowserCommand): boolean {
  if (command.action === "measure_interaction") return command.interaction !== undefined;
  return (
    inputActions.has(command.action) && !(command.action === "tabs" && command.operation === "list")
  );
}
/** Pending commands across every tab of one thread. */
export class QueueBudget {
  pending = 0;
  readonly limit: number;
  constructor(limit = 128) {
    this.limit = limit;
  }
}
/**
 * What holds a tab until someone answers it, as the command's result: `{pending_dialog}` for a
 * page dialog, `{pending_auth}` for a site's sign-in only the person gives.
 */
export type TabHold = Record<string, unknown>;
/** One tab's bounded queue; dialog answers deliberately bypass renderer work. */
export class SessionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private dialogWaiters = new Set<() => void>();
  private dialogWork: Promise<void> | undefined;
  private dialog: () => TabHold | undefined;
  private budget: QueueBudget;
  constructor(dialog: () => TabHold | undefined, budget = new QueueBudget()) {
    this.dialog = dialog;
    this.budget = budget;
  }
  get idle(): boolean {
    return this.pending === 0 && !this.dialogWork;
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
    if (this.pending >= 32 || this.budget.pending >= this.budget.limit)
      return Promise.reject(new BrowserActionError("queue_full"));
    this.pending++;
    this.budget.pending++;
    const result = this.tail.then(work);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
        this.budget.pending--;
      });
    return result;
  }
  /** Dialogs pause renderer replies; return their state so the next tool can answer. */
  async untilDialog(run: () => Promise<unknown>): Promise<unknown> {
    let notify: (() => void) | undefined;
    const dialog = new Promise<unknown>((resolve) => {
      notify = () => {
        const hold = this.dialog();
        if (hold) resolve(hold);
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
