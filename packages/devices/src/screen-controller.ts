import type { ScreenManager } from "@ace/screen";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";

/** Screen and device tools must consult the same lease for a Simulator window. */
export function mirrorDeviceController(
  session: DeviceSession,
  screen: ScreenManager,
  authorize: (actor: Actor) => void,
  emit: () => void,
): void {
  const id = session.capture?.screenSessionId;
  if (!id) return;
  const control = session.lease.current();
  if (!control) {
    screen.controller(id, "none");
    return;
  }
  const ticket = session.lease.ticket(control);
  screen.controller(id, control.kind, control.owner, {
    authorize() {
      authorize(control);
      session.lease.assert(control, ticket);
    },
    released() {
      if (session.lease.holds(control, ticket)) {
        session.lease.release(control.owner);
        emit();
      }
    },
  });
}
