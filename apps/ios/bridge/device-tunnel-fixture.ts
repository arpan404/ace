import type { LoopbackAction, LoopbackListening } from "@ace/native-host";
import type { LoopbackHost } from "./device-loopback.ts";
import type { MachineTunnel, TunnelStream } from "./machine-tunnel.ts";

/*
 * A machine's tunnel and the phone's loopback listeners, in memory, for the device tab tests
 * and the bridge's throughput bench. The fake machine serves each port with `serve`.
 */

export class TunnelRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** One stream as the machine sees it: what the phone wrote, and a way to answer. */
export interface MachineSide {
  readonly port: number;
  readonly received: Uint8Array[];
  ended: boolean;
  answer(bytes: Uint8Array): void;
  finish(): void;
  reset(): void;
}

export type Serve = (side: MachineSide) => void;

export class FakeTunnel implements MachineTunnel {
  #ports: number[];
  readonly #listeners = new Set<() => void>();
  readonly sides: MachineSide[] = [];
  /** A refusal code for `open`, per port. */
  readonly refuse = new Map<number, string>();
  closed = false;
  readonly #serve: Serve;
  constructor(ports: number[] = [], serve: Serve = () => {}) {
    this.#ports = ports;
    this.#serve = serve;
  }
  readonly ports = {
    get: () => this.#ports,
    subscribe: (changed: () => void) => {
      this.#listeners.add(changed);
      return () => this.#listeners.delete(changed);
    },
  };
  setPorts(ports: number[]): void {
    this.#ports = ports;
    for (const listener of this.#listeners) listener();
  }
  open(port: number): Promise<TunnelStream> {
    const refusal = this.refuse.get(port);
    if (refusal) return Promise.reject(new TunnelRefusal(refusal));
    let control!: ReadableStreamDefaultController<Uint8Array>;
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        control = controller;
      },
    });
    const side: MachineSide = {
      port,
      received: [],
      ended: false,
      answer: (bytes) => control.enqueue(bytes),
      finish: () => {
        control.close();
        finish();
      },
      reset: () => {
        control.error(new Error("reset"));
        finish();
      },
    };
    this.sides.push(side);
    const stream: TunnelStream = {
      readable,
      write: async (chunk) => {
        side.received.push(chunk);
      },
      end: () => {
        side.ended = true;
      },
      reset: () => side.reset(),
      closed,
    };
    this.#serve(side);
    return Promise.resolve(stream);
  }
  close(): void {
    this.closed = true;
  }
}

/** The phone's listeners: ports other apps hold are busy; every action is recorded. */
export class FakeLoopbackHost implements LoopbackHost {
  readonly busy = new Set<number>();
  listening: number[] = [];
  readonly asked: number[][] = [];
  readonly actions: { connection: string; action: LoopbackAction; bytes?: Uint8Array }[] = [];
  /** Answers each write as sent at once, as an idle socket does. */
  autoWritten: ((connection: string) => void) | undefined;
  async listen(ports: number[]): Promise<LoopbackListening> {
    this.asked.push(ports);
    this.listening = ports.filter((port) => !this.busy.has(port));
    return { listening: this.listening, busy: ports.filter((port) => this.busy.has(port)) };
  }
  act(connection: string, action: LoopbackAction, bytes?: Uint8Array): void {
    this.actions.push(bytes ? { connection, action, bytes } : { connection, action });
    if (action === "write") this.autoWritten?.(connection);
  }
  of(connection: string, action: LoopbackAction) {
    return this.actions.filter(
      (entry) => entry.connection === connection && entry.action === action,
    );
  }
}

/** Lets every pending promise and stream read run. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}
