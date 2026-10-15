import { join } from "node:path";
import type { DaemonTarget } from "./target.ts";

/**
 * The local daemon's log folder (`<home>/logs`, where its rotating file sink writes `ace.jsonl`),
 * or its home when it has not written logs yet. A remote, fake or unusable daemon has nothing on
 * this machine to show.
 */
function daemonLogsPath(
  target: DaemonTarget,
  exists: (path: string) => boolean,
): string | undefined {
  if (target.kind !== "managed" && target.kind !== "attach") return undefined;
  const logs = join(target.home, "logs");
  if (exists(logs)) return logs;
  return exists(target.home) ? target.home : undefined;
}

/**
 * What "Show Logs" opens, in order: the daemon's log folder, then the app's own logs folder
 * (`desktop.jsonl`, macOS `~/Library/Logs/ace`). The two live in different places, so each
 * existing one is opened; the app's folder alone still answers for a remote daemon.
 */
export function logFolders(
  target: DaemonTarget,
  desktopLogs: string,
  exists: (path: string) => boolean,
): string[] {
  const daemon = daemonLogsPath(target, exists);
  const folders = daemon ? [daemon] : [];
  if (desktopLogs !== daemon && exists(desktopLogs)) folders.push(desktopLogs);
  return folders;
}
