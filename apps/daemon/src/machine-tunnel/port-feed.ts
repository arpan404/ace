import { pollPorts } from "@ace/preview/detection";
import { visiblePorts } from "./policy.ts";

/*
 * The listening ports every tunnel connection is told about (ADR 0194): one scan for the whole
 * daemon, by the preview's adaptive `pollPorts`, running only while a connection listens. Each
 * listener hears the whole set, once it is known and then only when it changes.
 */

const sameList = (a: readonly number[], b: readonly number[] | undefined) =>
  b !== undefined && a.length === b.length && a.every((port, index) => port === b[index]);

export function tunnelPortFeed(options: {
  listening(): Promise<ReadonlySet<number>>;
  acePorts(): Promise<ReadonlySet<number>>;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  limit: number;
  onError(error: unknown): void;
  /** The scan's quickest and slowest pace, in ms; 1 s and 5 s unless given. */
  minDelay?: number;
  maxDelay?: number;
}) {
  const listeners = new Map<(ports: number[]) => void, { last: number[] | undefined }>();
  let latest: number[] | undefined;
  let loop: AbortController | undefined;
  const publish = () => {
    const ports = latest;
    if (!ports) return;
    for (const [listener, state] of listeners) {
      if (sameList(ports, state.last)) continue;
      state.last = ports;
      listener(ports);
    }
  };
  const start = () => {
    if (loop) return;
    const controller = new AbortController();
    loop = controller;
    void pollPorts<number>({
      signal: controller.signal,
      scan: async () => {
        const [listening, ace] = await Promise.all([options.listening(), options.acePorts()]);
        const ports = visiblePorts(listening, ace, options.limit);
        if (!controller.signal.aborted) {
          latest = ports;
          publish();
        }
        return new Set(ports);
      },
      // The scan publishes the whole set itself; the diff only paces the loop.
      onChange: () => {},
      onError: options.onError,
      wait: options.wait,
      minDelay: options.minDelay ?? 1000,
      maxDelay: options.maxDelay ?? 5000,
    }).catch(options.onError);
  };
  const stop = () => {
    loop?.abort();
    loop = undefined;
    latest = undefined;
  };
  return {
    subscribe(listener: (ports: number[]) => void): () => void {
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
    close: stop,
  };
}
