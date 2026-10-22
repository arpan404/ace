import type { Automation, AutomationEvent } from "@ace/protocol";
import type { Dependencies } from "./contracts.ts";
import { compileSchedule, type Recurrence } from "./recurrence.ts";

interface PreparedConfiguration {
  automation: Automation;
  revision: number;
  recurrence: Recurrence | undefined;
  unsubscribe: (() => void) | undefined;
  watchError: unknown;
}
export interface WatchHooks {
  onReady?: (id: string, revision: number) => void;
  onError?: (id: string, revision: number, error: unknown) => void;
}
/** Runtime subscriptions are prepared before persistence, then handed over after commit. */
export class AutomationRuntime {
  private revisions = new Map<string, number>();
  private recurrences = new Map<string, Recurrence>();
  private watches = new Map<string, () => void>();
  private revision = 0;
  private deps: Dependencies;
  private isLive: () => boolean;
  private receive: (id: string, event: AutomationEvent) => void;
  private report: (error: unknown) => void;
  constructor(
    deps: Dependencies,
    isLive: () => boolean,
    receive: (id: string, event: AutomationEvent) => void,
    report: (error: unknown) => void,
  ) {
    this.deps = deps;
    this.isLive = isLive;
    this.receive = receive;
    this.report = report;
  }
  prepare(automation: Automation, hooks?: WatchHooks): PreparedConfiguration {
    const revision = ++this.revision;
    const recurrence =
      automation.trigger.kind === "schedule"
        ? compileSchedule(automation.trigger.schedule)
        : undefined;
    let unsubscribe: (() => void) | undefined;
    let watchError: unknown;
    if (
      automation.enabled &&
      this.isLive() &&
      this.deps.workspace &&
      automation.trigger.kind === "file"
    ) {
      try {
        unsubscribe = this.deps.workspace.subscribe(
          automation.workspace,
          automation.trigger.paths,
          async (event) => {
            if (
              this.isLive() &&
              this.current(automation.id) === revision &&
              this.watches.has(automation.id)
            )
              this.receive(automation.id, event);
          },
          {
            onReady: () => hooks?.onReady?.(automation.id, revision),
            onError: (error) => hooks?.onError?.(automation.id, revision, error),
          },
        );
      } catch (error) {
        watchError = error;
      }
    }
    return { automation, revision, recurrence, unsubscribe, watchError };
  }
  install(prepared: PreparedConfiguration): void {
    const { automation, revision, recurrence, unsubscribe } = prepared;
    const previous = this.watches.get(automation.id);
    this.revisions.set(automation.id, revision);
    if (automation.enabled && recurrence) this.recurrences.set(automation.id, recurrence);
    else this.recurrences.delete(automation.id);
    if (unsubscribe) this.watches.set(automation.id, unsubscribe);
    else this.watches.delete(automation.id);
    this.release(previous);
  }
  /** Drop a failed async watcher only when its generation is still current. */
  failed(id: string, revision: number): boolean {
    if (this.revisions.get(id) !== revision) return false;
    const unsubscribe = this.watches.get(id);
    this.watches.delete(id);
    this.revisions.delete(id);
    this.release(unsubscribe);
    return true;
  }
  hasWatch(id: string): boolean {
    return this.watches.has(id);
  }
  discard(prepared: PreparedConfiguration): void {
    this.release(prepared.unsubscribe);
  }
  current(id: string): number | undefined {
    return this.revisions.get(id);
  }
  recurrence(id: string): Recurrence | undefined {
    return this.recurrences.get(id);
  }
  needsWatch(automation: Automation): boolean {
    return (
      this.isLive() &&
      automation.enabled &&
      automation.trigger.kind === "file" &&
      this.deps.workspace !== undefined &&
      !this.watches.has(automation.id)
    );
  }
  remove(id: string): void {
    const unsubscribe = this.watches.get(id);
    this.watches.delete(id);
    this.recurrences.delete(id);
    this.revisions.delete(id);
    this.release(unsubscribe);
  }
  stop(): void {
    const releases = [...this.watches.values()];
    try {
      this.watches.clear();
      this.recurrences.clear();
      this.revisions.clear();
      for (const unsubscribe of releases) this.release(unsubscribe);
    } finally {
      this.watches.clear();
      this.recurrences.clear();
      this.revisions.clear();
    }
  }
  private release(unsubscribe: (() => void) | undefined): void {
    try {
      unsubscribe?.();
    } catch (error) {
      this.report(error);
    }
  }
}
