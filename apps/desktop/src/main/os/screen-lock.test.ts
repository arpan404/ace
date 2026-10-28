import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  linuxScreenLocked,
  linuxScreenSaverService,
  lockerRunning,
  screenLock,
  type ProcessTable,
} from "./screen-lock.ts";
import type { RunProgram } from "./tray-host.ts";

const answers =
  (stdout: string): RunProgram =>
  async () =>
    stdout;
const fails =
  (message: string): RunProgram =>
  async () => {
    throw new Error(message);
  };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A `/proc` with these processes of this user's: `[pid, comm, state]`. */
function processes(...entries: Array<[number, string, string]>): ProcessTable {
  const root = mkdtempSync(join(tmpdir(), "ace-proc-"));
  roots.push(root);
  for (const [pid, comm, state] of entries) {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "comm"), `${comm}\n`);
    writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0`);
  }
  return { root, uid: process.getuid?.() ?? 0 };
}

describe("linuxScreenSaverService", () => {
  it("sees GNOME's or KDE's ScreenSaver service on the session bus", async () => {
    const names = "(['org.freedesktop.DBus', ':1.4', 'org.gnome.ScreenSaver', ':1.9'],)\n";
    expect(await linuxScreenSaverService(answers(names))).toBe(true);
    const kde = "(['org.freedesktop.DBus', 'org.freedesktop.ScreenSaver'],)\n";
    expect(await linuxScreenSaverService(answers(kde))).toBe(true);
  });

  it("sees none on a bus without one (a bare window manager, a headless X server)", async () => {
    expect(await linuxScreenSaverService(answers("(['org.freedesktop.DBus', ':1.2'],)\n"))).toBe(
      false,
    );
  });

  it("sees none without a session bus, where Chromium falls back to the X screen saver too", async () => {
    expect(
      await linuxScreenSaverService(
        fails("Command failed: gdbus call …\nError connecting: Could not connect: No such file"),
      ),
    ).toBe(false);
  });

  it("can't tell when the question can't be asked", async () => {
    expect(await linuxScreenSaverService(fails("spawn gdbus ENOENT"))).toBeUndefined();
    expect(await linuxScreenSaverService(fails("Command failed (killed)"))).toBeUndefined();
  });
});

describe("lockerRunning", () => {
  it("sees a running or sleeping lock program", () => {
    expect(lockerRunning(processes([10, "bash", "S"], [11, "swaylock", "S"]))).toBe(true);
    expect(lockerRunning(processes([12, "i3lock", "R"]))).toBe(true);
  });

  it("ignores a lock program that exited but was not yet reaped, and other programs", () => {
    expect(lockerRunning(processes([10, "hyprlock", "Z"], [11, "xscreensaver", "S"]))).toBe(false);
  });

  it("ignores another user's lock program and an unreadable table", () => {
    const table = processes([10, "swaylock", "S"]);
    expect(lockerRunning({ ...table, uid: table.uid + 1 })).toBe(false);
    expect(lockerRunning({ root: join(table.root, "missing"), uid: table.uid })).toBe(false);
  });
});

describe("linuxScreenLocked", () => {
  it("takes a blanked X screen saver with no ScreenSaver service for an unlocked screen", () => {
    expect(
      linuxScreenLocked({ chromiumLocked: true, screenSaverService: false, lockerRunning: false }),
    ).toBe(false);
  });

  it("honours a desktop's lock, and Chromium's reading when its source can't be told", () => {
    expect(
      linuxScreenLocked({ chromiumLocked: true, screenSaverService: true, lockerRunning: false }),
    ).toBe(true);
    expect(
      linuxScreenLocked({
        chromiumLocked: true,
        screenSaverService: undefined,
        lockerRunning: false,
      }),
    ).toBe(true);
  });

  it("honours a lock program Chromium doesn't know about (swaylock, hyprlock)", () => {
    expect(
      linuxScreenLocked({ chromiumLocked: false, screenSaverService: false, lockerRunning: true }),
    ).toBe(true);
  });

  it("is unlocked when nothing says locked", () => {
    expect(
      linuxScreenLocked({ chromiumLocked: false, screenSaverService: true, lockerRunning: false }),
    ).toBe(false);
  });
});

describe("screenLock", () => {
  it("keeps Chromium's reading as it is off Linux", async () => {
    let reading = true;
    const locked = await screenLock({
      platform: "darwin",
      chromiumLocked: () => reading,
      run: fails("never asked"),
    });
    expect(locked()).toBe(true);
    reading = false;
    expect(locked()).toBe(false);
  });

  it("on an idle Xvfb, asks the bus once and reads the screen as unlocked", async () => {
    let asked = 0;
    const locked = await screenLock({
      platform: "linux",
      chromiumLocked: () => true,
      run: async () => {
        asked++;
        return "(['org.freedesktop.DBus'],)\n";
      },
      processes: processes([10, "bash", "S"]),
    });
    expect(locked()).toBe(false);
    expect(locked()).toBe(false);
    expect(asked).toBe(1);
  });
});
