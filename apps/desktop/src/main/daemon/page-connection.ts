import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";
import { startFailed } from "./status.ts";

export interface PageConnectionPorts {
  /** What the home kept while the daemon starts (`DaemonRuntime.earlyConnection`). */
  early(): Promise<DaemonConnection | undefined>;
  /** The daemon's connection once it answers; rejects on a failed start. */
  connection(): Promise<DaemonConnection>;
  current(): DaemonStatus;
  onStatus(listener: (status: DaemonStatus) => void): () => void;
  /** Reloads the app's page, which asks for its connection again. */
  reload(): void;
  /** The first hand-off of each kind, for the launch log. */
  handed?(kind: "early" | "daemon"): void;
}

/**
 * The page's daemon hand-off, and when the page must reload to follow the daemon.
 *
 * `daemon` waits for the daemon to answer; it rejects only on a real failure, and the page,
 * which then shows its connection screen, reloads once the daemon runs again. `page` is the
 * page's own hand-off: while the daemon starts it is what the home kept, so the page opens on
 * what it cached, reconnecting, and follows the real target once the daemon runs. A start that
 * fails after that reloads the page, which then shows the failure rather than waiting on a
 * daemon that won't come.
 *
 * Whether the page got the early target is decided in one step with the status as it is then,
 * after the home's files were read: a start that ended meanwhile (running, failed or stopping)
 * takes the normal path. So a failure either comes before that step (normal path: the page is
 * refused and shows it) or after it (the page reloads), whichever order the two arrive in.
 */
export function createPageConnection(ports: PageConnectionPorts): {
  daemon(): Promise<DaemonConnection>;
  page(): Promise<DaemonConnection>;
  stop(): void;
} {
  let missed = false;
  let handedEarly = false;
  const said = new Set<"early" | "daemon">();
  const say = (kind: "early" | "daemon") => {
    if (said.has(kind)) return;
    said.add(kind);
    ports.handed?.(kind);
  };
  const daemon = async () => {
    try {
      const handed = await ports.connection();
      say("daemon");
      return handed;
    } catch (error) {
      missed = true;
      throw error;
    }
  };
  const stop = ports.onStatus((status) => {
    if (status.state === "running") handedEarly = false;
    if (
      handedEarly &&
      startFailed(status) &&
      status.state !== "stopping" &&
      status.state !== "stopped"
    ) {
      handedEarly = false;
      ports.reload();
      return;
    }
    if (status.state !== "running" || !missed) return;
    missed = false;
    ports.reload();
  });
  return {
    daemon,
    async page() {
      const early = await ports.early();
      const now = ports.current();
      if (!early || now.state === "running" || startFailed(now)) return daemon();
      handedEarly = true;
      say("early");
      return early;
    },
    stop,
  };
}
