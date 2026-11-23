import { statSync } from "node:fs";
import { returnToLaunchDirectory } from "./launch-directory.ts";

// The daemon entry's first import (`tools/release/src/entry.ts`, `apps/daemon/src/cli.ts`):
// module code runs in import order, so this runs before anything reads `process.cwd()`.
const outcome = returnToLaunchDirectory(process.env, {
  chdir: (path) => process.chdir(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
});
// The folder is the person's; it is never written to a log.
if (outcome === "stayed")
  process.stderr.write("ace: the launch folder is unavailable; running in ace's own folder\n");
