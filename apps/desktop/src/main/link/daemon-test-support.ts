import { createServer, type Server } from "node:net";
import { startDaemon, AdapterRegistry } from "@ace/daemon";
import type { DaemonProcess } from "../daemon/supervisor.ts";

/** Test support: real daemons in this process for the desktop's composition tests. */

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** A loopback port held by `blocker` until the test closes it. */
export async function freePort(): Promise<{ port: number; blocker: Server }> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return { port: address.port, blocker };
}

/** Starts the daemon in this process; a start that throws (port in use) exits with code 1. */
export function inProcessDaemons(home: string, port: number) {
  const started: Daemon[] = [];
  const spawn = (): DaemonProcess => {
    let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let exited = false;
    let daemon: Daemon | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      exit?.(code, signal);
    };
    startDaemon({
      // Desktop link composition exercises sockets and lifecycle, without provider CLIs.
      engine: { registry: new AdapterRegistry() },
      modelInstances: [],
      config: {
        dataDir: home,
        host: "127.0.0.1",
        port,
        listen: "local",
        remotePort: 0,
        logLevel: "silent",
      },
    }).then(
      (running) => {
        daemon = running;
        started.push(running);
      },
      () => finish(1, null),
    );
    return {
      kill(signal) {
        void (daemon?.close() ?? Promise.resolve()).then(() => finish(null, signal));
      },
      onExit(listener) {
        exit = listener;
      },
    };
  };
  return { spawn, started };
}
