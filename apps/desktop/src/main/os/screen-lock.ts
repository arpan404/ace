import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunProgram } from "./tray-host.ts";

/**
 * The D-Bus services Chromium asks whether the screen is locked on Linux
 * (ui/base/idle/idle_linux.cc). Where none runs, Chromium falls back to the X server's screen
 * saver, which only blanks the screen: an idle Xvfb, or a desktop that blanks without locking,
 * then reads as "locked".
 */
export const screenSaverServices = [
  "org.freedesktop.ScreenSaver",
  "org.cinnamon.ScreenSaver",
  "org.gnome.ScreenSaver",
  "org.mate.ScreenSaver",
  "org.xfce.ScreenSaver",
] as const;

/** Lock screens that are their own programs rather than a desktop's D-Bus service. */
const lockers = new Set([
  "hyprlock",
  "swaylock",
  "gtklock",
  "waylock",
  "i3lock",
  "slock",
  "xsecurelock",
]);

/** `gdbus`'s question to the session bus: which names are owned? */
const namesQuestion = [
  "call",
  "--session",
  "--dest",
  "org.freedesktop.DBus",
  "--object-path",
  "/org/freedesktop/DBus",
  "--method",
  "org.freedesktop.DBus.ListNames",
];

/**
 * Whether a desktop's ScreenSaver service, the source Chromium trusts for "locked", runs on the
 * session bus. False where none does, or where there is no session bus to ask (Chromium can't
 * either, so it reads the X screen saver). Undefined when the question can't be asked (no
 * `gdbus`, a timeout).
 */
export async function linuxScreenSaverService(run: RunProgram): Promise<boolean | undefined> {
  try {
    const reply = await run("gdbus", namesQuestion);
    return screenSaverServices.some((name) => reply.includes(`'${name}'`));
  } catch (error) {
    return error instanceof Error && /Error connecting|Could not connect/.test(error.message)
      ? false
      : undefined;
  }
}

/** A `/proc`-like folder; the real one in the app, a temp dir in tests. */
export interface ProcessTable {
  root: string;
  uid: number;
}

/** Whether a lock screen program of this user's is running (not exited and awaiting reaping). */
export function lockerRunning(table: ProcessTable): boolean {
  let entries: string[];
  try {
    entries = readdirSync(table.root);
  } catch {
    return false;
  }
  return entries.some((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    const path = join(table.root, pid);
    try {
      if (statSync(path).uid !== table.uid) return false;
      if (!lockers.has(readFileSync(join(path, "comm"), "utf8").trim())) return false;
      const stat = readFileSync(join(path, "stat"), "utf8");
      // The state follows the command's closing parenthesis: Z and X have exited.
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0];
      return state !== undefined && !["Z", "X", "x"].includes(state);
    } catch {
      return false;
    }
  });
}

export interface LinuxLockFacts {
  /** Chromium's reading: `powerMonitor.getSystemIdleState(…) === "locked"`. */
  chromiumLocked: boolean;
  /** `linuxScreenSaverService`'s answer, read once per launch. */
  screenSaverService: boolean | undefined;
  /** `lockerRunning`'s answer. */
  lockerRunning: boolean;
}

/**
 * Whether a Linux screen is really locked. A lock program running is a lock. Chromium's
 * "locked" counts where it came from a desktop's ScreenSaver service (GNOME, KDE, Cinnamon,
 * MATE, Xfce), or where that can't be told; with no such service it is the X screen saver
 * blanking an idle screen, which still draws, so it is not a lock.
 */
export function linuxScreenLocked(facts: LinuxLockFacts): boolean {
  return facts.lockerRunning || (facts.chromiumLocked && facts.screenSaverService !== false);
}

/**
 * The app's "is the screen locked?" check. Elsewhere, Chromium's reading as it is; on Linux,
 * `linuxScreenLocked` over the desktop's ScreenSaver service (asked once, here) and its lock
 * programs.
 */
export async function screenLock(options: {
  platform: NodeJS.Platform;
  chromiumLocked: () => boolean;
  run: RunProgram;
  processes?: ProcessTable;
}): Promise<() => boolean> {
  if (options.platform !== "linux") return options.chromiumLocked;
  const screenSaverService = await linuxScreenSaverService(options.run);
  const processes = options.processes ?? { root: "/proc", uid: process.getuid?.() ?? -1 };
  return () =>
    linuxScreenLocked({
      chromiumLocked: options.chromiumLocked(),
      screenSaverService,
      lockerRunning: lockerRunning(processes),
    });
}
