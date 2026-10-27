import type { AdmissionRequest, MaintenanceHold, ServerMessage } from "@ace/protocol";

/**
 * The fixture's "pause new work" gate (`admission.request`), shared by every connection: a set
 * of holds, of which clients add and remove only `user`. A scenario may add a system hold (an
 * update, kill-all) as the daemon would. A connection that read it hears each later change.
 */
export class FakeAdmission {
  private readonly holds = new Set<MaintenanceHold>();
  private readonly watchers = new Set<(message: ServerMessage) => void>();
  /** Adds or removes `hold`, as the tray, an update or kill-all would. */
  set(hold: MaintenanceHold, on: boolean): void {
    if (on === this.holds.has(hold)) return;
    if (on) this.holds.add(hold);
    else this.holds.delete(hold);
    for (const send of this.watchers) send({ type: "admission.changed", admission: this.state() });
  }
  /** One connection's handler; scope refusals happen before it (`request-scopes.ts`). */
  session(emit: (message: ServerMessage) => void) {
    return {
      handle: (request: AdmissionRequest) => {
        this.watchers.add(emit);
        if (request.operation !== "status") this.set("user", request.operation === "pause");
        emit({
          type: "admission.result",
          requestId: request.requestId,
          ok: true,
          admission: this.state(),
        });
      },
      close: () => {
        this.watchers.delete(emit);
      },
    };
  }
  private state() {
    return { holds: [...this.holds].toSorted(), busy: 0, waiting: 0 };
  }
}
