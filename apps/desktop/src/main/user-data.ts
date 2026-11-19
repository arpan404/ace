import { join, resolve } from "node:path";

/** The app's own data folder, a child of `app.getPath("appData")`. */
export const userDataName = "ace-next";

/**
 * Where the app keeps its own data (window state, settings, web storage, browser profiles and
 * the single-instance lock): `ACE_DESKTOP_USER_DATA` when set, else `<appData>/ace-next`
 * (macOS `~/Library/Application Support/ace-next`). It never depends on the daemon target.
 */
export function desktopUserData(input: { explicit: string | undefined; appData: string }): string {
  return input.explicit ? resolve(input.explicit) : join(input.appData, userDataName);
}

/**
 * Where the app writes its logs and freeze records when `ACE_DESKTOP_USER_DATA` is set: inside
 * that folder, so a development or test app never writes to (or reads freezes from) the
 * installed app's logs (macOS `~/Library/Logs/ace desktop`). Undefined keeps the system's.
 */
export function desktopLogs(explicit: string | undefined): string | undefined {
  return explicit ? join(resolve(explicit), "logs") : undefined;
}
