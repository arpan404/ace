import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/**
 * Starts a command once this process has exited, from a helper that lives outside the app.
 *
 * Electron's `app.relaunch` runs its waiting helper from `process.execPath`. In an AppImage
 * that file is on the image's temporary FUSE mount, which goes away with the app, so the
 * helper dies and nothing starts. This helper is the system's shell: it waits for EOF on a
 * pipe whose write end only this process holds (the kernel closes it at exit, the same signal
 * Electron's helper uses), then execs the command with stdin from /dev/null.
 *
 * Node's spawn closes only close-on-exec descriptors, and Chromium leaves many open without
 * it (IndexedDB locks, session files, the AppImage mount, the devtools socket). The helper
 * closes every descriptor above stderr first, so the new app inherits none of them. bash
 * can close any number; dash, the other common /bin/sh, only 0 to 9.
 */
const closeInherited = {
  bash: 'for fd in /proc/$$/fd/*; do fd=${fd##*/}; if [ "$fd" -gt 2 ] && [ -e "/proc/$$/fd/$fd" ]; then exec {fd}>&-; fi; done',
  sh: "exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-",
};
const waitThenExec = (close: string) => `cat >/dev/null; ${close}; exec "$@" </dev/null`;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** bash where the system has it (every mainstream desktop distribution does), else /bin/sh. */
export function relaunchShell(executable: (file: string) => boolean = isExecutable): {
  path: string;
  script: string;
} {
  const bash = ["/bin/bash", "/usr/bin/bash"].find(executable);
  return bash
    ? { path: bash, script: waitThenExec(closeInherited.bash) }
    : { path: "/bin/sh", script: waitThenExec(closeInherited.sh) };
}

export function relaunchAfterExit(command: { execPath: string; args: readonly string[] }): void {
  const shell = relaunchShell();
  const child = spawn(
    shell.path,
    ["-c", shell.script, "ace-relaunch", command.execPath, ...command.args],
    { detached: true, stdio: ["pipe", "inherit", "inherit"] },
  );
  child.on("error", () => {});
  child.unref();
  // The pipe must not keep this process alive; its write end closes when the process exits.
  const stdin: { unref?: () => void } | null = child.stdin;
  stdin?.unref?.();
}
