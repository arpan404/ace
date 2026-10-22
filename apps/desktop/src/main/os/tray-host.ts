import { execFile } from "node:child_process";

/** Runs a program and resolves its standard output; rejects with the error when it fails. */
export type RunProgram = (file: string, args: readonly string[]) => Promise<string>;

/** `gdbus`'s question to the session's StatusNotifier watcher: is a tray showing icons? */
const hostQuestion = [
  "call",
  "--session",
  "--dest",
  "org.kde.StatusNotifierWatcher",
  "--object-path",
  "/StatusNotifierWatcher",
  "--method",
  "org.freedesktop.DBus.Properties.Get",
  "org.kde.StatusNotifierWatcher",
  "IsStatusNotifierHostRegistered",
];

/**
 * Whether the Linux desktop shows tray icons. Linux trays are StatusNotifier hosts (KDE's
 * panel, GNOME's AppIndicator extension, waybar, …) registered with the session's watcher;
 * stock GNOME has none, and there the tray icon is never seen. False when the watcher is
 * missing or says no host is registered. True when the answer can't be had (no `gdbus`, a
 * timeout): only a desktop known to lack a tray is treated as one.
 */
export async function linuxTrayHost(run: RunProgram): Promise<boolean> {
  try {
    const reply = await run("gdbus", hostQuestion);
    return !/\bfalse\b/.test(reply);
  } catch (error) {
    if (!(error instanceof Error)) return true;
    // gdbus answered: nothing owns the watcher's name, so nothing shows tray icons.
    return !/ServiceUnknown|NameHasNoOwner|UnknownObject|UnknownMethod/.test(error.message);
  }
}

/** `RunProgram` with a real child process, given up on after `timeoutMs`. */
export function runProgram(timeoutMs: number): RunProgram {
  return (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`));
          else resolve(stdout);
        },
      );
    });
}
