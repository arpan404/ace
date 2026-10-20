import { app, crashReporter, type WebContents } from "electron";
import type { Log } from "../log/desktop-log.ts";
import { crashDumps, startCrashReporter } from "./crash-reporter.ts";
import { processDeaths } from "./process-deaths.ts";

/** Local-only Crashpad under the app's data folder; returns the dump folder. */
export function startLocalCrashReporter(userData: string): string {
  return startCrashReporter(
    {
      setPath: (name, path) => app.setPath(name, path),
      start: (options) => crashReporter.start(options),
    },
    userData,
  );
}

/**
 * Every helper and renderer death, into the desktop log. Registered before the app is ready
 * so a GPU or network service that fails at launch is recorded too.
 */
export function watchProcessDeaths(options: {
  log: Log;
  dumps: string;
  /** What the renderer drew: `main`, `secondary` or `browser`. */
  windowOf(contents: WebContents): string;
}): void {
  const deaths = processDeaths({
    log: options.log,
    now: Date.now,
    dumps: (since) => crashDumps(options.dumps, since),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  });
  app.on("child-process-gone", (_event, details) => void deaths.child(details));
  app.on(
    "render-process-gone",
    (_event, contents, details) => void deaths.renderer(options.windowOf(contents), details),
  );
}
