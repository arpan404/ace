import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";

export interface PageConnectionPorts {
  /** The daemon's connection once it answers; rejects on a failed start. */
  connection(): Promise<DaemonConnection>;
  onStatus(listener: (status: DaemonStatus) => void): () => void;
  /** Reloads the app's page, which asks for its connection again. */
  reload(): void;
  /** The first hand-off, for the launch log. */
  handed?(): void;
}

/**
 * The page's daemon hand-off. The page shows "Starting ace…" until its daemon answers, however
 * long a first start takes. Only a real failure rejects; the page then shows its connection
 * screen, and it reloads once the daemon runs again.
 */
export function createPageConnection(ports: PageConnectionPorts): {
  connection(): Promise<DaemonConnection>;
  stop(): void;
} {
  let missed = false;
  let said = false;
  const stop = ports.onStatus((status) => {
    if (status.state !== "running" || !missed) return;
    missed = false;
    ports.reload();
  });
  return {
    async connection() {
      try {
        const handed = await ports.connection();
        if (!said) ports.handed?.();
        said = true;
        return handed;
      } catch (error) {
        missed = true;
        throw error;
      }
    },
    stop,
  };
}
