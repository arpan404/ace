import { useDaemonConnection } from "@/boot/connection.tsx";
import { revealer } from "@/boot/open-external.ts";

const localHosts = ["localhost", "127.0.0.1", "[::1]"];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Show in Finder, when the daemon's files are on this computer (the desktop app with a local
 * daemon); undefined in a browser or against another machine.
 */
export function useLocalReveal(): ((path: string) => Promise<void>) | undefined {
  const connection = useDaemonConnection();
  const local = connection.mode === "daemon" && localHosts.includes(hostOf(connection.url));
  return local ? revealer() : undefined;
}
