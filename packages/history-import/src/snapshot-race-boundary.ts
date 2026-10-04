// Test-only preload: pause one real WAL stat while the parent commits to the temp database.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { parentPort } from "node:worker_threads";
const originalOpen = fs.open;
let paused = false;
fs.open = async (path, flags, mode) => {
  const file = await originalOpen(path, flags, mode);
  if (String(path).endsWith("opencode.db-wal")) {
    const originalStat = file.stat.bind(file);
    let calls = 0;
    file.stat = new Proxy(file.stat, {
      async apply(_target, _receiver, args) {
        const result = await Reflect.apply(originalStat, file, args);
        // safeOpen checks regular-file identity first; the second stat freezes the copy size.
        if (++calls === 2 && !paused) {
          paused = true;
          const port = parentPort;
          if (!port) throw new Error("Snapshot boundary requires a worker");
          await new Promise<void>((resolve) => {
            const receive = (message: unknown) => {
              if (message !== "snapshot-continue") return;
              port.off("message", receive);
              resolve();
            };
            port.on("message", receive);
            port.postMessage({ snapshotPause: true });
          });
        }
        return result;
      },
    });
  }
  return file;
};
syncBuiltinESMExports();
