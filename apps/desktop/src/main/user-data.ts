import { join, resolve } from "node:path";
import type { DaemonTarget } from "./daemon/target.ts";

/** The app's own data folder (`app.getPath("appData")` child) beside an isolated daemon home. */
export const isolatedUserDataName = "ace-next";

/**
 * Where the app keeps its own data (window state, settings, web storage, browser profiles),
 * following the daemon home's choice:
 *
 * - `ACE_DESKTOP_USER_DATA` always wins;
 * - beside the isolated `~/.ace-next` daemon home, `<appData>/ace-next`, never the
 *   `<appData>/ace` folder an older ace 0.x app may own (on macOS,
 *   `~/Library/Application Support/ace-next`);
 * - otherwise Electron's default for the app (`<appData>/ace`): undefined.
 *
 * It must be set before the single-instance lock, which lives in this folder: an isolated app
 * then never defers to (or blocks) a running 0.x app.
 */
export function desktopUserData(input: {
  explicit: string | undefined;
  target: DaemonTarget;
  appData: string;
}): string | undefined {
  if (input.explicit) return resolve(input.explicit);
  const { target } = input;
  const isolated = (target.kind === "managed" || target.kind === "attach") && target.isolated;
  return isolated ? join(input.appData, isolatedUserDataName) : undefined;
}
