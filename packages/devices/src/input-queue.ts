import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { LifecycleOwner } from "./lifecycle.ts";
/** A request's presence checks share one deadline across every queue retry. */
export interface DeviceInputWait {
  active(): boolean;
  waited(): string | undefined;
  yield(): Promise<void>;
}

const personReturned = Symbol("personReturned");

export async function enqueueDeviceInput<T>(
  session: DeviceSession,
  actor: Actor,
  run: (authorize: () => void) => Promise<T>,
  owner: LifecycleOwner,
  presence?: DeviceInputWait,
): Promise<T> {
  owner.authorize(session, actor);
  const ticket = session.lease.ticket(actor);
  if (session.pending >= 32)
    throw new DeviceError("busy", "Device input queue is full", "Wait for pending device actions.");
  // Waiting for the person retains this ticket too; a takeover still invalidates it.
  const release = session.lease.retain(actor, ticket);
  session.pending++;
  const guard = () => {
    owner.authorize(session, actor);
    session.lease.assert(actor, ticket);
  };
  try {
    for (;;) {
      guard();
      await presence?.yield();
      guard();
      const next = session.tail.then(async (): Promise<{ result: T } | typeof personReturned> => {
        guard();
        // Give the queue back before waiting, so the person's input can pass us.
        if (presence?.active()) return personReturned;
        const result = await run(guard);
        guard();
        return { result };
      });
      session.tail = next.then(
        () => {},
        () => {},
      );
      const outcome = await next;
      if (outcome !== personReturned) {
        const result = outcome.result;
        const waited = presence?.waited();
        return waited && typeof result === "object" && result !== null && !Array.isArray(result)
          ? { ...result, waited }
          : result;
      }
    }
  } finally {
    release();
    session.pending--;
  }
}

/**
 * The person's input in cowork (ADR 0143): it goes in while an agent holds the device, in order
 * with the agent's input, without the controller lease. Only a person's Take control keeps it
 * out, and the caller checks that before choosing this lane.
 */
export function enqueueSharedInput<T>(
  session: DeviceSession,
  actor: Actor,
  run: (authorize: () => void) => Promise<T>,
  owner: LifecycleOwner,
): Promise<T> {
  owner.authorize(session, actor);
  if (session.pending >= 32)
    throw new DeviceError("busy", "Device input queue is full", "Wait for pending device actions.");
  session.pending++;
  const guard = () => {
    owner.authorize(session, actor);
    // Shared input queued before a Take control must respect its new exclusive holder.
    if (session.pendingController !== undefined || session.lease.current()?.kind === "human")
      session.lease.assert(actor);
  };
  const next = session.tail
    .then(async () => {
      guard();
      return run(guard);
    })
    .finally(() => {
      session.pending--;
    });
  session.tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
