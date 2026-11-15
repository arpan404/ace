/*
 * The thread list's first subscribe, as a pure state machine (the sidebar is its shell).
 *
 * Before its first subscribe the list waits, so that it can resume from the list it kept
 * instead of asking for the whole list. It has one deadline, set when it is opened (first held)
 * and never moved, and a current filter that may change any number of times. It subscribes,
 * once, for the filter current at that moment, as soon as it is held, its socket can carry a
 * subscribe, and either the kept read for that filter has settled (found or not) or both the
 * deadline has passed and the client has had its first welcome. After that the list is no
 * longer starting: every later change is the sidebar's ordinary business.
 */

/** A filter, as the key its kept list is stored under. */
export type FilterKey = string;

export type ListStartup =
  | {
      phase: "waiting";
      filter: FilterKey;
      /** A list is kept for this client at all; without one there is nothing to wait for. */
      kept: boolean;
      /** The kept read for `filter` has settled. */
      read: boolean;
      /** 250 ms have passed since the list was opened. */
      deadline: boolean;
      welcomed: boolean;
      held: boolean;
      /** The socket can carry a subscribe (the hello is out). */
      connected: boolean;
    }
  | { phase: "subscribed" };

export type StartupInput =
  | { type: "held" }
  | { type: "released" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "welcome" }
  | { type: "deadline" }
  | { type: "filter"; filter: FilterKey }
  | { type: "read"; filter: FilterKey };

export function listStartup(
  filter: FilterKey,
  options: { kept: boolean; welcomed: boolean; connected: boolean },
): ListStartup {
  return {
    phase: "waiting",
    filter,
    kept: options.kept,
    read: false,
    deadline: false,
    welcomed: options.welcomed,
    held: false,
    connected: options.connected,
  };
}

/**
 * The next state, and the filter to subscribe for when this input makes the list subscribe.
 * A subscribed list ignores every input.
 */
export function stepStartup(
  state: ListStartup,
  input: StartupInput,
): { state: ListStartup; subscribe?: FilterKey } {
  if (state.phase === "subscribed") return { state };
  const next = { ...state };
  switch (input.type) {
    case "held":
      next.held = true;
      break;
    case "released":
      next.held = false;
      break;
    case "connected":
      next.connected = true;
      break;
    case "disconnected":
      next.connected = false;
      break;
    case "welcome":
      next.welcomed = true;
      break;
    case "deadline":
      next.deadline = true;
      break;
    case "filter":
      // A new filter's kept list is read afresh; the deadline stays the opening's.
      if (input.filter !== next.filter) {
        next.filter = input.filter;
        next.read = false;
      }
      break;
    case "read":
      // A read for a filter that is no longer current says nothing about this one.
      if (input.filter === next.filter) next.read = true;
      break;
  }
  const settled = !next.kept || next.read || (next.deadline && next.welcomed);
  if (next.held && next.connected && settled)
    return { state: { phase: "subscribed" }, subscribe: next.filter };
  return { state: next };
}
