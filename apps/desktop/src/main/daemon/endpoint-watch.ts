import { watch, type FSWatcher } from "node:fs";
import type { EndpointWatch } from "./readiness.ts";

const endpointFile = "daemon-endpoint";

/**
 * Watches `home` for its `daemon-endpoint` changing. Undefined when the folder cannot be
 * watched; the lookup then polls as before. A watch that fails later only stops waking it.
 */
export function watchEndpointFile(home: string): EndpointWatch | undefined {
  let pending = false;
  let wake: (() => void) | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(home, { persistent: false }, (_event, name) => {
      // Some platforms name no file: any change may be the endpoint.
      if (name && name !== endpointFile) return;
      pending = true;
      wake?.();
    });
  } catch {
    return undefined;
  }
  watcher.on("error", () => watcher.close());
  return {
    changed() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        wake = () => {
          wake = undefined;
          pending = false;
          resolve();
        };
      });
    },
    close: () => watcher.close(),
  };
}
