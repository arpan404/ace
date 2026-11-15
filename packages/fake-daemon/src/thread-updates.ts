import type { Command, EventPayload } from "@ace/protocol";
import { fakeAccessModes } from "./permissions.ts";
import type { ThreadHost } from "./thread-host.ts";

/*
 * The `thread.updated` events a person's thread settings make: a queued model switch and an
 * access change. Pure: the daemon appends what these return.
 */

/** A switch asked for: queued until the thread is idle, lossy across providers. */
export function switchUpdate(
  host: ThreadHost,
  payload: Extract<Command["payload"], { type: "thread.switch" }>,
  at: number,
): EventPayload {
  return {
    type: "thread.updated",
    switch: {
      selection: { ...payload.selection, options: payload.selection.options ?? {} },
      state: "queued",
      lossy: payload.selection.provider !== host.view.thread.provider,
      at,
    },
  };
}

/** An access change, pending until the provider applies it; refused for a mode not offered. */
export function permissionUpdate(
  host: ThreadHost,
  payload: Extract<Command["payload"], { type: "thread.permission.set" }>,
): { error: string } | { event: EventPayload } {
  const offers =
    host.view.thread.capabilities?.accessModes ?? fakeAccessModes(host.view.thread.provider);
  if (payload.access && !offers.some((offer) => offer.mode === payload.access))
    return { error: "permission_mode_unsupported" };
  return {
    event: {
      type: "thread.updated",
      permission: {
        override: payload.access,
        effective: host.view.thread.permission?.effective ?? null,
        pending: true,
      },
    },
  };
}
