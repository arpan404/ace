import type { AppUpdate, AppUpdateReport, ServerMessage } from "@ace/protocol";

/**
 * The fixture's desktop app update report (`appUpdate.request`): Unknown until a scenario seeds
 * one, and each connection that read it hears later changes, as the daemon tells its watchers.
 */
export class FakeAppUpdate {
  private report: AppUpdateReport | null = null;
  private readonly watchers = new Set<(message: ServerMessage) => void>();
  /** The desktop app reported, as it does over its loopback route. */
  set(report: AppUpdateReport): void {
    if (JSON.stringify(report) === JSON.stringify(this.report)) return;
    this.report = report;
    for (const send of this.watchers) send({ type: "appUpdate.changed", update: this.current() });
  }
  session(emit: (message: ServerMessage) => void) {
    return {
      handle: (requestId: string) => {
        this.watchers.add(emit);
        emit({ type: "appUpdate.result", requestId, ok: true, update: this.current() });
      },
      close: () => {
        this.watchers.delete(emit);
      },
    };
  }
  private current(): AppUpdate {
    return { report: this.report };
  }
}
