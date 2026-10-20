import { logFields } from "@ace/diagnostics";
import type { DaemonOptions } from "./services/options.ts";
import { DaemonStop } from "./stop-reason.ts";

type Daemon = Awaited<ReturnType<typeof import("./index.ts").startDaemon>>;
type Signal = "SIGINT" | "SIGTERM";
const SHUTDOWN_LIMIT_MS = 7_500;
/** Install the process lifetime before startup can advertise an endpoint. */
export async function runDaemonProcess(
  start: (options: DaemonOptions) => Promise<Daemon>,
  options: DaemonOptions,
  signals: {
    once(signal: Signal, listener: () => void): unknown;
    removeListener(signal: Signal, listener: () => void): unknown;
  } = process,
  shutdown: {
    after(run: () => void, milliseconds: number): () => void;
    exit(code: number): void;
  } = {
    after(run, milliseconds) {
      const timer = setTimeout(run, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    exit: (code) => process.exit(code),
  },
): Promise<Daemon | undefined> {
  const lifetime = new AbortController();
  let daemon: Daemon | undefined;
  let cancelExit: (() => void) | undefined;
  const remove = () => {
    signals.removeListener("SIGINT", interrupt);
    signals.removeListener("SIGTERM", terminate);
  };
  const stop = (signal: Signal) => {
    cancelExit ??= shutdown.after(() => {
      const message = `Daemon shutdown exceeded ${SHUTDOWN_LIMIT_MS}ms; pending resources did not exit`;
      const pending = daemon?.pendingShutdown() ?? [];
      console.error(pending.length ? `${message}: ${pending.join(", ")}` : message);
      // The file log outlives the console of an app-launched daemon.
      daemon?.log.log("error", message, logFields([["pending", pending.slice(0, 24)]]));
      daemon?.log.flushSync();
      shutdown.exit(1);
    }, SHUTDOWN_LIMIT_MS);
    const reason = { source: "signal", signal } as const;
    // The daemon logs the reason once: an abort during startup and a close after it share it.
    lifetime.abort(new DaemonStop(reason));
    if (daemon)
      void daemon
        .close(reason)
        .catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        })
        .finally(() => {
          remove();
        });
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  signals.once("SIGINT", interrupt);
  signals.once("SIGTERM", terminate);
  try {
    daemon = await start({
      ...options,
      signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
    });
    if (lifetime.signal.aborted) {
      await daemon.close();
      remove();
      return undefined;
    }
    return daemon;
  } catch (error) {
    remove();
    if (lifetime.signal.aborted) return undefined;
    throw error;
  }
}
