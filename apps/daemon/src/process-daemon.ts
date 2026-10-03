import type { DaemonOptions } from "./services/options.ts";

type Daemon = Awaited<ReturnType<typeof import("./index.ts").startDaemon>>;
/** Install the process lifetime before startup can advertise an endpoint. */
export async function runDaemonProcess(
  start: (options: DaemonOptions) => Promise<Daemon>,
  options: DaemonOptions,
  signals: Pick<NodeJS.Process, "once" | "removeListener"> = process,
): Promise<Daemon | undefined> {
  const lifetime = new AbortController();
  let daemon: Daemon | undefined;
  const remove = () => {
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  };
  const stop = () => {
    lifetime.abort();
    if (daemon)
      void daemon
        .close()
        .catch((error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        })
        .finally(remove);
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
