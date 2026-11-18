import { systemFilesClock } from "@ace/files-native";
import { FolderWatch } from "./folder-watch.ts";
import { FilesTool, findFilesBinary } from "./tool.ts";
import type { ServiceContext } from "../services/types.ts";

/** The daemon's ace-files and the folder watches built on it. */
export type FilesNative = { tool: FilesTool; folders: FolderWatch };

/**
 * The daemon's one ace-files (ADR 0178). Nothing starts here: the process comes up on the first
 * listing, quick open or watch that needs it, and the two books stay cheap until then. A machine
 * without the binary still gets its Files panel through the TypeScript path.
 */
export function startFilesNative(context: ServiceContext): FilesNative {
  const tool = new FilesTool({
    binary: findFilesBinary(),
    clock: {
      now: () => context.now(),
      setTimeout: (callback, ms) => systemFilesClock.setTimeout(callback, ms),
    },
    log: (level, message, fields) => context.log.log(level, `ace-files: ${message}`, fields),
  });
  const folders = new FolderWatch(
    { watch: (path, onBatch) => tool.watch(path, onBatch) },
    { clock: systemFilesClock },
  );
  return { tool, folders };
}

/** Close idle roots on the daemon's maintenance beat, not on its startup path. */
export function sweepFilesRoots(native: FilesNative, context: ServiceContext): Promise<void> {
  return native.tool.sweep().then((closed) => {
    if (closed.length)
      context.log.log("debug", "Closed idle ace-files roots", { count: closed.length });
  });
}
