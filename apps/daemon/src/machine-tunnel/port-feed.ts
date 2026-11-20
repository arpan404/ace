import type { AcePorts } from "./ace-ports.ts";
import { visiblePorts } from "./policy.ts";

/*
 * The machine's listening ports for the tunnel (ADR 0194): one scan for the whole daemon, shared
 * by every tunnel connection and by the guard on ace's own ports. Each pass reads the OS tables
 * once (one `lsof` on macOS) and answers both questions: which ports listen, and which of them
 * ace's processes hold. It runs while a connection listens, at an adaptive pace; an open that
 * finds the guard's last scan too old asks for one at once, and every open waiting shares it.
 * Each listener hears the visible set once it is known and then only when it changes.
 */

export interface ListeningScan {
  listening: ReadonlySet<number>;
  /** The ports ace's processes hold. */
  owned: ReadonlySet<number>;
}

export interface PortWatchOptions {
  /** One pass over the machine's listeners. */
  scan(): Promise<ListeningScan>;
  acePorts: AcePorts;
  /** A monotonic clock, in ms. */
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  limit: number;
  onError(error: unknown): void;
  /** The scan's quickest and slowest pace, in ms; 1 s and 5 s unless given. */
  minDelay?: number;
  maxDelay?: number;
}

export interface PortWatch {
  /** Hear the visible ports; the scan runs while anyone listens. Returns how to stop. */
  subscribe(listener: (ports: number[]) => void): () => void;
  /** Resolves once the guard has a scan at most its `scanMs` old, or the one asked for failed. */
  fresh(): Promise<void>;
  close(): void;
}

const sameList = (a: readonly number[], b: readonly number[] | undefined) =>
  b !== undefined && a.length === b.length && a.every((port, index) => port === b[index]);

export function machinePortWatch(options: PortWatchOptions): PortWatch {
  const minDelay = options.minDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 5000;
  const listeners = new Map<(ports: number[]) => void, { last: number[] | undefined }>();
  let latest: number[] | undefined;
  let loop: AbortController | undefined;
  let scanning: Promise<boolean> | undefined;
  let closed = false;
  const publish = () => {
    const ports = latest;
    if (!ports) return;
    for (const [listener, state] of listeners) {
      if (sameList(ports, state.last)) continue;
      state.last = ports;
      listener(ports);
    }
  };
  /** One pass; resolves whether the visible set changed. */
  const pass = async (): Promise<boolean> => {
    const at = options.now();
    try {
      const result = await options.scan();
      options.acePorts.scanned(at, result.owned);
      const ports = visiblePorts(result.listening, options.acePorts.all(), options.limit);
      const changed = !sameList(ports, latest);
      latest = ports;
      publish();
      return changed;
    } catch (error) {
      options.acePorts.scanned(at, undefined);
      options.onError(error);
      return false;
    }
  };
  const scanOnce = (): Promise<boolean> => {
    if (scanning) return scanning;
    const running = pass().finally(() => {
      if (scanning === running) scanning = undefined;
    });
    scanning = running;
    return running;
  };
  const start = () => {
    if (loop || closed) return;
    const controller = new AbortController();
    loop = controller;
    void (async () => {
      let delay = minDelay;
      while (!controller.signal.aborted) {
        const changed = await scanOnce();
        delay = changed ? minDelay : Math.min(maxDelay, delay * 2);
        if (controller.signal.aborted) break;
        await options.wait(delay, controller.signal);
      }
    })().catch(options.onError);
  };
  const stop = () => {
    loop?.abort();
    loop = undefined;
    latest = undefined;
  };
  return {
    subscribe(listener) {
      const state: { last: number[] | undefined } = { last: undefined };
      listeners.set(listener, state);
      if (latest) {
        state.last = latest;
        listener(latest);
      }
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    async fresh() {
      if (!options.acePorts.fresh()) await scanOnce();
    },
    close() {
      closed = true;
      listeners.clear();
      stop();
    },
  };
}
