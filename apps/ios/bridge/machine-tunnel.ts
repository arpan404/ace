import { loopbackProblemOf, type LoopbackProblem } from "@ace/ui-core/device-loopback";

/*
 * The machine's localhost tunnel as the phone uses it (ADR 0194). `@ace/client` owns the tunnel
 * itself; this is the shape the device side codes against.
 */

/** One TCP connection to a port on the machine's loopback. */
export interface TunnelStream {
  readonly readable: ReadableStream<Uint8Array>;
  /** Resolves once the tunnel admitted the chunk (its credit is the backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  reset(): void;
  readonly closed: Promise<void>;
}

export interface MachineTunnel {
  /**
   * Rejects with a client error coded `tunnel_off`, `tunnel_forbidden`, `tunnel_port_refused`,
   * `tunnel_limit` or `offline`. Nothing listening on the port resets the stream.
   */
  open(port: number): Promise<TunnelStream>;
  /** The machine's loopback ports, minus ace's own. */
  ports: { get(): readonly number[]; subscribe(changed: () => void): () => void };
  close(): void;
}

/** The problem a refused `open` names; anything uncoded reads as the machine being offline. */
export function tunnelRefusal(error: unknown): LoopbackProblem {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? loopbackProblemOf(code) : "offline";
}
