import { useDaemonConnection } from "@/boot/connection.tsx";
import { onThisComputer } from "@/boot/main-machine.ts";
import { revealer } from "@/boot/open-external.ts";

/**
 * Show in Finder, when the daemon's files are on this computer (the desktop app with a local
 * daemon); undefined in a browser or against another machine.
 */
export function useLocalReveal(): ((path: string) => Promise<void>) | undefined {
  const connection = useDaemonConnection();
  return onThisComputer(connection) ? revealer() : undefined;
}
