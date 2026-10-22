/*
 * Sharing a window in the Linux live-view suites, the way a person would. X11 lists the
 * desktop's windows, named by desktop id. Wayland lists none: the machine's sharing dialog
 * picks. How the person's answer is given depends on the desktop:
 *   GNOME     the dialog can't be answered through accessibility, so the suite records the
 *             approval the person would give there (test scaffolding only; ace never writes
 *             the permission store) and the helper restores it silently;
 *   KDE       its chooser lists windows as buttons: `approve` presses the window's while the
 *             live view starts, as the person would;
 *   Hyprland  the portal's chooser is the runner's portal-picker.sh, told the answer first.
 *   and Sway
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { ScreenInventory, type ScreenTarget } from "@ace/protocol";
import type { EvalWorld } from "../evals/world.ts";
import type { LiveViewer } from "./live-viewer.ts";
import { answerChooser, scriptedChooser } from "./portal-chooser.ts";

const exec = promisify(execFile);
const tests = new URL("../../../../native/screen-helper-linux/tests/computer/", import.meta.url)
  .pathname;
const seedPortal = join(tests, "seed_portal.py");
const portalDialog = join(tests, "portal_dialog.py");

/** The runner made a KDE Plasma session (Wayland or X11). */
export const kde = (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("KDE");
/** xdg-desktop-portal-wlr (Sway) shares whole monitors only, never one window. */
export const windowsShared = process.env.ACE_LINUX_DESKTOP_E2E !== "sway";

/** Where the helper keeps the sharing dialog's restore token for this daemon. */
export function restoreToken(ace: EvalWorld): string {
  return join(dirname(ace.daemon.tokenPath), "screen-artifacts", "portal", "restore-token");
}

/** Presses `title`'s button in KDE's sharing chooser, as the person would. */
export function approveInKdeChooser(title: string): Promise<unknown> {
  return exec("python3", [portalDialog, "approve", title]);
}

export type Shared = {
  target: ScreenTarget;
  /** The window's size, where the desktop lists it (X11). */
  size?: { width: number; height: number };
  /** The person's answer in the dialog, given while the start waits on it (KDE). */
  approve?: () => Promise<unknown>;
};

/**
 * The target that shares `app`'s window titled `title`, and on X11 its size. On GNOME the
 * person's approval of exactly that window is recorded first; `cleanups` takes it back. On
 * KDE, Hyprland and Sway the target names the app, so the person's view can read its elements
 * even though those desktops don't record what was picked.
 */
export async function shareWindow(
  session: string,
  ace: EvalWorld,
  viewer: LiveViewer,
  app: { desktopId: string; title: string },
  cleanups: (() => Promise<void>)[],
): Promise<Shared> {
  const inventory = ScreenInventory.parse(await viewer.request({ op: "targets" }));
  if (session === "x11") {
    const window = inventory.windows.find((entry) => entry.title === app.title);
    if (!window?.bounds) throw new Error(`No ${app.title} window: ${JSON.stringify(inventory)}`);
    // Named by its desktop id, as computer use names the same app.
    expect(window.bundleId).toBe(app.desktopId);
    return {
      target: { kind: "window", bundleId: window.bundleId, windowId: window.windowId },
      size: { width: window.bounds.width, height: window.bounds.height },
    };
  }
  // Nothing to list: the machine's own sharing dialog picks a window or a screen.
  expect(inventory).toEqual({
    displays: [],
    windows: [],
    chooser: { windows: windowsShared, displays: true },
  });
  const named: ScreenTarget = { kind: "window", bundleId: app.desktopId, windowId: 1 };
  if (kde) return { target: named, approve: () => approveInKdeChooser(app.title) };
  if (scriptedChooser) {
    await answerChooser({ window: app.desktopId });
    return { target: named };
  }
  const token = restoreToken(ace);
  await exec("python3", [
    seedPortal,
    "grant-remote-desktop",
    token,
    `${app.desktopId}.desktop`,
    app.title,
  ]);
  cleanups.push(async () => {
    await exec("python3", [seedPortal, "revoke-remote-desktop", token]).catch(() => {});
  });
  return { target: { kind: "chooser" } };
}

/** Starts the live view of `shared`, answering the dialog on the way where the desktop needs it. */
export async function startShared(viewer: LiveViewer, shared: Shared): Promise<unknown> {
  const [started] = await Promise.all([
    // As long as the daemon gives a Wayland start, the person included.
    viewer.request({ op: "start", target: shared.target }, 150_000),
    shared.approve?.(),
  ]);
  return started;
}
