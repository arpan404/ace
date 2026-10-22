import { spawn } from "node:child_process";

/**
 * Starts a command once this process has exited, from a helper that lives outside the app.
 *
 * Electron's `app.relaunch` runs its waiting helper from `process.execPath`. In an AppImage
 * that file is on the image's temporary FUSE mount, which goes away with the app, so the
 * helper dies and nothing starts. This helper is the system's `/bin/sh`: it waits for EOF on
 * a pipe whose write end only this process holds (the kernel closes it at exit, the same
 * signal Electron's helper uses), then execs the command with stdin from /dev/null.
 */
const waitThenExec = 'cat >/dev/null; exec "$@" </dev/null';

export function relaunchAfterExit(command: { execPath: string; args: readonly string[] }): void {
  const child = spawn(
    "/bin/sh",
    ["-c", waitThenExec, "ace-relaunch", command.execPath, ...command.args],
    {
      detached: true,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  child.on("error", () => {});
  child.unref();
  // The pipe must not keep this process alive; its write end closes when the process exits.
  const stdin: { unref?: () => void } | null = child.stdin;
  stdin?.unref?.();
}
