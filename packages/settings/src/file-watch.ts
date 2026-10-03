import { watch, watchFile, unwatchFile } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

type DirectoryWatch = (
  path: string,
  changed: (filename: string | null) => void,
  failed: () => void,
) => () => void;

const watchDirectory: DirectoryWatch = (path, changed, failed) => {
  const watcher = watch(path, (_event, filename) => changed(filename));
  watcher.on("error", failed);
  return () => watcher.close();
};

/** Ancestor notifications can miss directory creation; stat polling bridges
 * that gap only until the destination's own parent can be watched. */
export function createFileWatcher(directory: DirectoryWatch = watchDirectory) {
  return async (path: string, changed: () => void, failed: () => void): Promise<() => void> => {
    let parent = dirname(path);
    while (true) {
      try {
        await stat(parent);
        break;
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
          dirname(parent) === parent
        )
          throw error;
        parent = dirname(parent);
      }
    }
    const child = relative(parent, path).split(sep)[0];
    const stopDirectory = directory(
      parent,
      (filename) => {
        if (!filename || filename.split(sep)[0] === child) changed();
      },
      failed,
    );
    const polling = parent !== dirname(path);
    try {
      if (polling) watchFile(path, { persistent: false, interval: 500 }, changed);
    } catch (error) {
      stopDirectory();
      throw error;
    }
    return () => {
      stopDirectory();
      if (polling) unwatchFile(path, changed);
    };
  };
}
