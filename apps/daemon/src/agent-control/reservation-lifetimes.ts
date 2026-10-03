import type { ThreadId } from "@ace/protocol";
import type { DelegationReservation } from "./journal.ts";

/** At most four filesystem operations; cancellation owns their I/O signals. */
export class ReservationLifetimes {
  private entries = new Map<ThreadId, { parentId: ThreadId; controller: AbortController }>();
  watch(reservation: DelegationReservation) {
    const record = reservation.record;
    if (this.entries.has(record.childId) || this.entries.size >= 4)
      throw new Error("Reservation lifetime capacity");
    const entry = { parentId: record.parentId, controller: new AbortController() };
    this.entries.set(record.childId, entry);
    return {
      signal: entry.controller.signal,
      close: () => {
        if (this.entries.get(record.childId) === entry) this.entries.delete(record.childId);
      },
    };
  }
  cancel(thread: ThreadId, descendant: (target: ThreadId, ancestor: ThreadId) => boolean) {
    for (const entry of this.entries.values())
      if (entry.parentId === thread || descendant(entry.parentId, thread))
        entry.controller.abort(new Error("cancelled"));
  }
  close() {
    for (const entry of this.entries.values())
      entry.controller.abort(new Error("Admission closed"));
    this.entries.clear();
  }
}
