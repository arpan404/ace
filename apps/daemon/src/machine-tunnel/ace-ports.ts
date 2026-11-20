/*
 * Every port an ace process listens on, which the tunnel never connects to (ADR 0194): a
 * tunnelled connection arrives from loopback, and loopback is what those listeners trust. Read
 * from the listeners themselves, never a stored list, so a listener that moved is still refused.
 */

export interface AcePortSources {
  /** The ports ace's known listeners hold now (daemon, remote, gateway, Spade): read live. */
  listeners(): Iterable<number | undefined>;
  /** Processes whose every listener is ace's own: the daemon itself, Spade's service. */
  pids(): readonly number[];
  /** The ports `pids` listen on, from the OS (`processListeningPorts`). */
  scan(pids: readonly number[]): Promise<ReadonlySet<number>>;
  /** A monotonic clock, in ms. */
  now(): number;
  /** How long one process scan answers for; 1 s unless given. */
  scanMs?: number;
  /** A scan that failed: the last one that worked still answers. */
  onError?(error: unknown): void;
}

/**
 * The refused set, asked at each open: the known listeners read live, with every port the ace
 * processes hold (in-process servers such as the MCP endpoint or a git lease) from a process
 * scan at most `scanMs` old. Callers share a scan under way.
 */
export function acePortReader(sources: AcePortSources): () => Promise<ReadonlySet<number>> {
  const scanMs = sources.scanMs ?? 1000;
  let held: { at: number; ports: ReadonlySet<number> } | undefined;
  let scanning: Promise<ReadonlySet<number>> | undefined;
  const scanned = (): Promise<ReadonlySet<number>> => {
    const at = sources.now();
    if (held && at - held.at < scanMs) return Promise.resolve(held.ports);
    scanning ??= sources
      .scan(sources.pids())
      .then((ports) => {
        held = { at, ports };
        return ports;
      })
      .catch((error: unknown) => {
        sources.onError?.(error);
        return held?.ports ?? new Set<number>();
      })
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  };
  return async () => {
    const ports = new Set(await scanned());
    for (const port of sources.listeners()) if (port !== undefined) ports.add(port);
    return ports;
  };
}
