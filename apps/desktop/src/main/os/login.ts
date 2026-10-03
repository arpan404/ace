/** The argument the login item passes where the OS supports login-item arguments. */
export const backgroundArgument = "--background";

/**
 * Whether this launch should start with no window: the app was started at login and the
 * person keeps ace running in the background (tray), so the login start is quiet.
 *
 * - Windows passes the login item's `--background` argument.
 * - macOS ignores login-item arguments; Electron reports `wasOpenedAtLogin` instead.
 * - Linux has no launch at login yet (it would need an XDG autostart entry), so only an
 *   explicit `--background` starts hidden there.
 *
 * Without background mode there would be no tray to reach the app, so it always opens.
 */
export function startHidden(launch: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  wasOpenedAtLogin: boolean;
  background: boolean;
}): boolean {
  if (!launch.background) return false;
  if (launch.argv.includes(backgroundArgument)) return true;
  return launch.platform === "darwin" && launch.wasOpenedAtLogin;
}
