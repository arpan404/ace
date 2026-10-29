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
