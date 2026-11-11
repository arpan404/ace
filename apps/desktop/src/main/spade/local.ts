import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { spadeDirect } from "./direct.ts";
import { spadeEndpointWatch } from "./endpoint-watch.ts";

/** Spade's files change several times in one start; tell the page once they settle. */
const settleMs = 150;

/**
 * The direct path to the Spade beside this app's daemon: `<ACE_HOME>/spade`, the same home the
 * app resolved for its daemon. `home` is undefined for a daemon on another machine (or the
 * in-page fake), where there is no local Spade to reach.
 */
export function localSpade(options: { home: string | undefined; onChange(): void }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const endpoints = spadeEndpointWatch({
    home: options.home,
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    watch(directory, changed, lost) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, file) =>
          changed(typeof file === "string" ? file : undefined),
        );
        watcher.once("error", () => {
          watcher.close();
          lost();
        });
        return () => watcher.close();
      } catch {
        return undefined;
      }
    },
    now: Date.now,
    onChange() {
      clearTimeout(timer);
      timer = setTimeout(options.onChange, settleMs);
    },
  });
  return { direct: spadeDirect(endpoints), close: () => endpoints.close() };
}
