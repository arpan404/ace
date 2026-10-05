import { join } from "node:path";
import type { DaemonTarget } from "./target.ts";

/**
 * What "Show Logs" opens: the local daemon's log folder (`<home>/logs`, where the daemon's
 * rotating file sink writes), or its home when it has not written logs yet. A remote, fake or
 * unusable daemon has nothing on this machine to show.
 */
export function daemonLogsPath(
  target: DaemonTarget,
  exists: (path: string) => boolean,
): string | undefined {
  if (target.kind !== "managed" && target.kind !== "attach") return undefined;
  const logs = join(target.home, "logs");
  if (exists(logs)) return logs;
  return exists(target.home) ? target.home : undefined;
}
