import type { LoopbackProblem } from "@ace/ui-core/device-loopback";
import type { LoopbackAction, LoopbackListening } from "@ace/native-host";
import { tunnelRefusal, type MachineTunnel, type TunnelStream } from "./machine-tunnel.ts";

/*
 * The phone's loopback connections carried to the machine (ADR 0194). Swift owns the listeners
 * and moves bytes; here each accepted connection becomes one tunnel stream on the same port.
 * Both directions are paced: the phone reads a connection's next chunk only after the tunnel
 * admitted the last one, and the next chunk from the machine waits until Swift sent the last.
 */

/** The loopback side of the native host, injected so tests drive it without Swift. */
export interface LoopbackHost {
  listen(ports: number[]): Promise<LoopbackListening>;
  act(connection: string, action: LoopbackAction, bytes?: Uint8Array): void;
}

export interface LoopbackReports {
  /** A connection on `port` failed for `problem`, or (undefined) the machine answered on it. */
  port(port: number, problem: LoopbackProblem | undefined): void;
  /** Another machine's device tab took the phone's listeners. */
  released(): void;
}

interface Connection {
  readonly port: number;
  stream: TunnelStream | undefined;
  /** The machine sent at least one byte: a later reset is a dropped connection, not "nothing". */
  answered: boolean;
  /** Swift has sent the last chunk written to it. */
  written: (() => void) | undefined;
  /** The page sent all it will, and the machine did: the connection is finished. */
  phoneEnded: boolean;
  machineEnded: boolean;
  done: boolean;
}

export class DeviceLoopback {
  readonly #host: LoopbackHost;
  readonly #tunnel: () => MachineTunnel | undefined;
  readonly #reports: LoopbackReports;
  readonly #connections = new Map<string, Connection>();

  constructor(
    host: LoopbackHost,
    tunnel: () => MachineTunnel | undefined,
    reports: LoopbackReports,
  ) {
    this.#host = host;
    this.#tunnel = tunnel;
    this.#reports = reports;
  }

  /** How many connections are open, for diagnostics. */
  get open(): number {
    return this.#connections.size;
  }

  /** One `aceLoopback` event from Swift. */
  event(event: string, connection: string, value: number | Uint8Array): void {
    switch (event) {
      case "accept":
        if (typeof value === "number") this.#accept(connection, value);
        return;
      case "data":
        if (typeof value !== "number") this.#fromPhone(connection, value);
        return;
      case "written": {
        const open = this.#connections.get(connection);
        const resume = open?.written;
        if (open) open.written = undefined;
        resume?.();
        return;
      }
      case "end": {
        const open = this.#connections.get(connection);
        if (!open?.stream) return;
        open.phoneEnded = true;
        open.stream.end();
        this.#settle(connection);
        return;
      }
      case "reset":
        this.#drop(connection, false);
        return;
      case "released":
        this.#reports.released();
        return;
    }
  }

  /** Every connection ends: the machine's runtime is stopping. */
  close(): void {
    for (const id of this.#connections.keys()) this.#drop(id, true);
  }

  #accept(id: string, port: number): void {
    const tunnel = this.#tunnel();
    if (!tunnel) {
      this.#reports.port(port, "offline");
      this.#host.act(id, "reset");
      return;
    }
    const connection: Connection = {
      port,
      stream: undefined,
      answered: false,
      written: undefined,
      phoneEnded: false,
      machineEnded: false,
      done: false,
    };
    this.#connections.set(id, connection);
    tunnel.open(port).then(
      (stream) => {
        if (connection.done) {
          stream.reset();
          return;
        }
        connection.stream = stream;
        void this.#toPhone(id, connection, stream);
        this.#host.act(id, "read");
      },
      (error: unknown) => {
        if (connection.done) return;
        this.#reports.port(port, tunnelRefusal(error));
        this.#drop(id, true);
      },
    );
  }

  #fromPhone(id: string, bytes: Uint8Array): void {
    const connection = this.#connections.get(id);
    const stream = connection?.stream;
    if (!connection || !stream) return;
    stream.write(bytes).then(
      () => {
        if (!connection.done) this.#host.act(id, "read");
      },
      () => this.#drop(id, true),
    );
  }

  async #toPhone(id: string, connection: Connection, stream: TunnelStream): Promise<void> {
    const reader = stream.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (connection.done) return;
        if (done) {
          connection.machineEnded = true;
          this.#host.act(id, "end");
          this.#settle(id);
          return;
        }
        if (value.byteLength === 0) continue;
        if (!connection.answered) {
          connection.answered = true;
          this.#reports.port(connection.port, undefined);
        }
        const sent = new Promise<void>((resolve) => {
          connection.written = resolve;
        });
        this.#host.act(id, "write", value);
        await sent;
      }
    } catch {
      // The stream reset: before any answer, nothing listens on the machine's port.
      if (connection.done) return;
      if (!connection.answered) this.#reports.port(connection.port, "nothing");
      this.#drop(id, true);
    } finally {
      reader.releaseLock();
    }
  }

  /** Both sides ended cleanly: forget the connection. Swift closes its side after `end`. */
  #settle(id: string): void {
    const connection = this.#connections.get(id);
    if (!connection?.phoneEnded || !connection.machineEnded) return;
    connection.done = true;
    connection.written?.();
    this.#connections.delete(id);
  }

  /** Ends a connection at once; `phone` resets the phone's side too. */
  #drop(id: string, phone: boolean): void {
    const connection = this.#connections.get(id);
    if (!connection) return;
    connection.done = true;
    this.#connections.delete(id);
    connection.written?.();
    connection.stream?.reset();
    if (phone) this.#host.act(id, "reset");
  }
}
