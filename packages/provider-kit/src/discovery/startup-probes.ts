import { probeOutput } from "../process.ts";

type Probe = typeof probeOutput;
type ProbeOptions = NonNullable<Parameters<Probe>[2]>;
type ProbeResult = Awaited<ReturnType<Probe>>;

export interface StartupProbes {
  /** Runs a probe, or joins the same probe already run since startup began. */
  probe: Probe;
  /** Every later call runs its own probe: a result read before a change must not answer after it. */
  close(): void;
}

interface Flight {
  result: Promise<ProbeResult>;
  waiting: number;
  controller: AbortController;
  settled: boolean;
}

/**
 * Startup reads each provider CLI twice: provider status and engine discovery both ask
 * `--version` and the login status. Until `close`, the same command with the same
 * environment runs once and every caller gets its result. Each caller keeps its own
 * timeout and abort; the shared run stops once no caller waits for it.
 *
 * Only open while nothing can change a login through ace (before the daemon listens):
 * afterwards each check must observe the CLI as it is now.
 */
export function startupProbes(
  options: {
    probe?: Probe;
    /** The shared run's own bound, at least the longest timeout any caller asks for. */
    ceilingMs?: number;
    schedule?: (callback: () => void, milliseconds: number) => () => void;
  } = {},
): StartupProbes {
  const run = options.probe ?? probeOutput;
  const ceilingMs = options.ceilingMs ?? 10_000;
  const schedule =
    options.schedule ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  let flights: Map<string, Flight> | undefined = new Map();
  const start = (command: string, args: readonly string[], probeOptions: ProbeOptions) => {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiting: 0,
      settled: false,
      result: run(command, args, {
        ...probeOptions,
        timeoutMs: Math.max(ceilingMs, probeOptions.timeoutMs ?? 0),
        signal: controller.signal,
      }),
    };
    flight.result.then(
      () => {
        flight.settled = true;
      },
      () => {
        flight.settled = true;
        // A failure is not an observation: the next caller tries again.
        if (flights?.get(key(command, args, probeOptions)) === flight)
          flights.delete(key(command, args, probeOptions));
      },
    );
    return flight;
  };
  const join = (flight: Flight, probeOptions: ProbeOptions): Promise<ProbeResult> => {
    const { signal } = probeOptions;
    if (signal?.aborted) return Promise.reject(new Error("Probe aborted"));
    if (flight.settled) return flight.result;
    flight.waiting++;
    return new Promise<ProbeResult>((resolve, reject) => {
      let left = false;
      const leave = (error?: Error) => {
        if (left) return;
        left = true;
        cancel();
        signal?.removeEventListener("abort", onAbort);
        flight.waiting--;
        if (flight.waiting === 0 && !flight.settled) flight.controller.abort();
        if (error) reject(error);
      };
      const onAbort = () => leave(new Error("Probe aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const cancel = schedule(
        () => leave(new Error("Probe timed out")),
        probeOptions.timeoutMs ?? 30_000,
      );
      flight.result.then(
        (result) => {
          if (left) return;
          leave();
          resolve(result);
        },
        (error: unknown) => leave(error instanceof Error ? error : new Error("Probe failed")),
      );
    });
  };
  return {
    probe(command, args, probeOptions = {}) {
      if (!flights || probeOptions.spawn || probeOptions.thread)
        return run(command, args, probeOptions);
      const id = key(command, args, probeOptions);
      let flight = flights.get(id);
      // A run every earlier caller left was aborted: it answers nobody.
      if (flight?.controller.signal.aborted) flight = undefined;
      if (!flight) {
        flight = start(command, args, probeOptions);
        flights.set(id, flight);
      }
      return join(flight, probeOptions);
    },
    close() {
      flights = undefined;
    },
  };
}

function key(command: string, args: readonly string[], options: ProbeOptions): string {
  const env = Object.entries(options.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify([command, args, env, options.maxBytes ?? null]);
}
