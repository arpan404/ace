import type { DaemonOptions } from "./services/options.ts";

type Daemon = Awaited<ReturnType<typeof import("./index.ts").startDaemon>>;
/** Install the process lifetime before startup can advertise an endpoint. */
export async function runDaemonProcess(
  start: (options: DaemonOptions) => Promise<Daemon>,
  options: DaemonOptions,
  signals: {
    once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
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
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  };
  const stop = () => {
    cancelExit ??= shutdown.after(() => {
      console.error("Daemon shutdown exceeded 7500ms; pending resources did not exit");
      shutdown.exit(1);
    }, 7_500);
    lifetime.abort();
    if (daemon)
      void daemon
        .close()
        .catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        })
        .finally(() => {
          remove();
        });
  };
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
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
