/*
 * TODO(ADR 0194): the tunnel branch exports `MachineTunnel` and `TunnelStream` from
 * `@ace/client`. These are the same interfaces, kept here until it merges; then this file
 * re-exports them.
 */

export interface MachineTunnel {
  /**
   * A stream to the machine's loopback on `port`. Rejects with a `ClientError` coded
   * `tunnel_off`, `tunnel_forbidden`, `tunnel_port_refused`, `tunnel_limit` or `offline`;
   * nothing listening there resets the stream.
   */
  open(port: number): Promise<TunnelStream>;
  /** The machine's loopback ports, minus ace's own. */
  ports: { get(): readonly number[]; subscribe(changed: () => void): () => void };
  close(): void;
}

export interface TunnelStream {
  readonly readable: ReadableStream<Uint8Array>;
  /** Resolves once the tunnel has admitted the chunk (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  reset(): void;
  readonly closed: Promise<void>;
}
