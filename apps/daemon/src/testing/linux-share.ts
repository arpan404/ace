/*
 * Sharing a window in the Linux live-view suites, the way a person would. X11 lists the
 * desktop's windows, named by desktop id. Wayland lists none: the machine's sharing dialog
 * picks, so the suite records the approval the person would give there (test scaffolding
 * only; ace never writes the permission store) and the helper restores it silently.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { ScreenInventory, type ScreenTarget } from "@ace/protocol";
import type { EvalWorld } from "../evals/world.ts";
import type { LiveViewer } from "./live-viewer.ts";

const exec = promisify(execFile);
const seedPortal = new URL(
  "../../../../native/screen-helper-linux/tests/computer/seed_portal.py",
  import.meta.url,
).pathname;

/** Where the helper keeps the sharing dialog's restore token for this daemon. */
export function restoreToken(ace: EvalWorld): string {
  return join(dirname(ace.daemon.tokenPath), "screen-artifacts", "portal", "restore-token");
}

/**
 * The target that shares `app`'s window titled `title`, and on X11 its size. On Wayland the
 * person's approval of exactly that window is recorded first; `cleanups` takes it back.
 */
export async function shareWindow(
  session: "x11" | "wayland",
  ace: EvalWorld,
  viewer: LiveViewer,
  app: { desktopId: string; title: string },
  cleanups: (() => Promise<void>)[],
): Promise<{ target: ScreenTarget; size?: { width: number; height: number } }> {
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
    chooser: { windows: true, displays: true },
  });
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
