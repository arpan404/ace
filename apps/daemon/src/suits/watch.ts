import { watch } from "node:fs";
import type { SuitSchedule, SuitWatch } from "./library.ts";

/** How often the root is looked at again where the OS can't watch it. */
const pollMs = 2000;

/**
 * Every change under the root: a recursive watch, or a watch of the root alone where recursive
 * watching isn't there (a Suit added or removed still shows), or polling where neither is.
 */
export const nodeSuitWatch: SuitWatch = (root, changed) => {
  for (const recursive of [true, false])
    try {
      const watcher = watch(root, { persistent: false, recursive }, () => changed());
      watcher.on("error", () => {});
      return () => watcher.close();
    } catch {
      /* Try the next way. */
    }
  const timer = setInterval(changed, pollMs);
  timer.unref();
  return () => clearInterval(timer);
};

export const nodeSuitSchedule: SuitSchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
