import type { AdmissionRequest, ServerMessage } from "@ace/protocol";

/**
 * The fixture's "pause new work" gate (`admission.request`), shared by every connection: one
 * that read it hears each later change, as the daemon tells its watching sockets.
 */
export class FakeAdmission {
  private paused = false;
  private readonly watchers = new Set<(message: ServerMessage) => void>();
  /** Seeds or flips the gate from a scenario, as the desktop tray would. */
  set(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    for (const send of this.watchers) send({ type: "admission.changed", admission: this.state() });
  }
  /** One connection's handler; scope refusals happen before it (`request-scopes.ts`). */
  session(emit: (message: ServerMessage) => void) {
    return {
      handle: (request: AdmissionRequest) => {
        this.watchers.add(emit);
        if (request.operation !== "status") this.set(request.operation === "pause");
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
    return { paused: this.paused, busy: 0 };
  }
}
