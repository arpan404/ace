import type { SpadeStartedWorker } from "./delegations.ts";
import type { SpadeQuiet } from "./quiet.ts";
import { spadeWakeOf, type SpadeWake } from "./wakes.ts";
import type { SpadeKnownEvent } from "./wire.ts";

/*
 * The capability events in a conversation's fold (`foldSpade`): goals and checks of done
 * (ADR 0159), workers (ADR 0161) on cards where they started, and wakes (ADR 0160) as the
 * open set the resting line reads. Each event does work in proportion to itself.
 */

/** What the fold keeps of them, beside its entries. */
export interface SpadeCapabilityState {
  /** Open wakes, by id, in the order they were set. */
  wakes: Map<string, SpadeWake>;
  /** Each worker's name by its id (a bot's, or an ace thread's), for the words of a wait. */
  workers: Map<string, string>;
  /** Each owned service's name by its id, for the words of a wait on it. */
  services: Map<string, string>;
}

export function emptySpadeCapabilities(): SpadeCapabilityState {
  return { wakes: new Map(), workers: new Map(), services: new Map() };
}

/**
 * Fold `event` when it is one of these: true when what the person sees changed, false when it
 * didn't, undefined when it isn't one. `place` puts a quiet line where the event happened;
 * `started` puts a started bot or ace agent on its call's card (`SpadeWorkersEntry`).
 */
export function foldSpadeCapability(
  state: SpadeCapabilityState,
  event: SpadeKnownEvent,
  place: (quiet: SpadeQuiet) => void,
  started: (call: string, worker: SpadeStartedWorker) => void,
): boolean | undefined {
  switch (event.type) {
    case "goal_set":
      place({ kind: "goal", title: event.title.trim() || event.text.trim() });
      return true;
    case "task_verified":
      place({
        kind: "checked",
        verdict: event.verdict,
        missing: event.missing.flatMap((item) =>
          typeof item === "string" && item.trim() ? [item.trim()] : [],
        ),
      });
      return true;
    case "worker_started":
      state.workers.set(event.worker, event.name);
      // A helper is its own line already (ADR 0152).
      if (event.kind === "helper") return true;
      started(event.call, {
        id: event.worker,
        kind: event.kind,
        name: event.name || (event.kind === "ace" ? "An ace agent" : "A worker"),
      });
      return true;
    case "worker_reported":
      // Stopping still counts as running: its stopped report follows. A worker started here
      // has its card, which says how it stands now; a report line would only go stale.
      if (event.kind === "helper" || event.state === "stopping") return false;
      if (state.workers.has(event.worker)) return false;
      place({
        kind: "worker-reported",
        worker: event.worker,
        ace: event.kind === "ace",
        name: event.name || state.workers.get(event.worker) || "A worker",
        state: event.state,
      });
      return true;
    case "service_started":
      state.services.set(event.service, event.name);
      return false;
    case "wake_set":
      state.wakes.set(event.wake, spadeWakeOf(event));
      return true;
    case "wake_fired":
    case "wake_cancelled":
      return state.wakes.delete(event.wake);
    default:
      return undefined;
  }
}
