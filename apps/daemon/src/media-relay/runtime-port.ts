import type { MediaRuntime } from "@ace/media/runtime";
import type { FromMedia } from "@ace/media/wire";
import type { MediaRelayPort, MediaRelayWatcher } from "./port.ts";

/**
 * The relay port of one ace-media runtime: one object for the runtime's life, however often
 * delivery is looked up, so its watchers are only the relay hosts that asked (D2). The runtime's
 * `onMessage` and `onExit` feed `message` and `exit`.
 */
export class RuntimeRelayPort implements MediaRelayPort {
  readonly #live: Pick<MediaRuntime, "supervisor" | "connections">;
  readonly #watchers = new Set<MediaRelayWatcher>();

  constructor(live: Pick<MediaRuntime, "supervisor" | "connections">) {
    this.#live = live;
  }

  /** Watchers now, for diagnostics. */
  get watchers(): number {
    return this.#watchers.size;
  }

  send: MediaRelayPort["send"] = (message, payload) => this.#live.supervisor.send(message, payload);
  closeStream: MediaRelayPort["closeStream"] = (message) =>
    void this.#live.supervisor.revoke(message);
  need: MediaRelayPort["need"] = () => this.#live.supervisor.need();
  available: MediaRelayPort["available"] = () =>
    this.#live.supervisor.health() !== "unavailable";
  claim: MediaRelayPort["claim"] = (ticket, claimant) =>
    this.#live.connections.claimRelay(ticket, claimant);

  watch(watcher: MediaRelayWatcher): () => void {
    this.#watchers.add(watcher);
    return () => void this.#watchers.delete(watcher);
  }

  message(message: FromMedia, payload: Uint8Array): void {
    for (const watcher of this.#watchers) watcher.message(message, payload);
  }

  exit(): void {
    for (const watcher of this.#watchers) watcher.exit();
  }
}
