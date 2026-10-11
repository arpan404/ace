import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { LifecycleOwner } from "./lifecycle.ts";
export function enqueueDeviceInput<T>(
  session: DeviceSession,
  actor: Actor,
  run: (authorize: () => void) => Promise<T>,
  owner: LifecycleOwner,
): Promise<T> {
  owner.authorize(session, actor);
  const ticket = session.lease.ticket(actor);
  if (session.pending >= 32)
    throw new DeviceError("busy", "Device input queue is full", "Wait for pending device actions.");
  const release = session.lease.retain(actor, ticket);
  session.pending++;
  const next = session.tail
    .then(async () => {
      owner.authorize(session, actor);
      session.lease.assert(actor, ticket);
      const guard = () => {
        owner.authorize(session, actor);
        session.lease.assert(actor, ticket);
      };
      const result = await run(guard);
      owner.authorize(session, actor);
      session.lease.assert(actor, ticket);
      return result;
    })
    .finally(() => {
      release();
      session.pending--;
    });
  session.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
