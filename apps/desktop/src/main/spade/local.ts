import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { newSpadeNonce } from "@ace/service/spade";
import { spadeDirect } from "./direct.ts";
import { spadeEndpointWatch } from "./endpoint-watch.ts";
import { ownerMode } from "./owner-mode.ts";

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
  // On an organization's host the direct path is off (ADR 0209 §3): its windows reach Spade
  // through their proven member socket. A change of owner ends every direct stream now.
  const mode = ownerMode(options.home, Date.now);
  const direct = spadeDirect(endpoints, { nonce: newSpadeNonce, orgHost: () => mode.orgHost() });
  let owner: ReturnType<typeof watch> | undefined;
  try {
    owner =
      options.home === undefined
        ? undefined
        : watch(options.home, { persistent: false }, (_event, file) => {
            if (typeof file === "string" && file !== "ace-owner.json") return;
            mode.changed();
            direct.modeChanged();
            options.onChange();
          });
    owner?.once("error", () => owner?.close());
  } catch {
    owner = undefined;
  }
  return {
    direct,
    close: () => {
      owner?.close();
      endpoints.close();
    },
  };
}
