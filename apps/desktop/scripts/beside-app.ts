import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { koffiBinary, mainProcessNeedsKoffi } from "./koffi.ts";

/**
 * Folders of `dist/` the package copies, as plain files, to `Resources/` beside app.asar.
 * extraResources would drop node_modules, and electron-builder never packs the app folder's
 * own node_modules. `daemon` is the daemon. `node_modules` holds the main process's native
 * packages (koffi on Windows: scripts/koffi.ts), which Node reaches by walking up from
 * app.asar and from app.asar.unpacked.
 */
export const packagedBesideApp = ["daemon", "node_modules"] as const;

/** What afterPack needs from electron-builder's context. */
export type PackedApp = {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
};

/** The packed app's `Resources` folder, where app.asar sits. */
export function packagedResources(app: PackedApp): string {
  return app.electronPlatformName === "darwin"
    ? join(app.appOutDir, `${app.packager.appInfo.productFilename}.app`, "Contents/Resources")
    : join(app.appOutDir, "resources");
}

/**
 * The package's afterPack hook: copies the built `packagedBesideApp` folders into the packed
 * app, then refuses a Windows package whose main process would find no koffi. It runs before
 * signing, so on macOS their native code is signed with the app.
 */
export function copyBesideApp(dist: string, arch: string): (app: PackedApp) => Promise<void> {
  return async (app) => {
    const resources = packagedResources(app);
    for (const folder of packagedBesideApp)
      if (existsSync(join(dist, folder)))
        await cp(join(dist, folder), join(resources, folder), {
          recursive: true,
          verbatimSymlinks: true,
        });
    if (!mainProcessNeedsKoffi(app.electronPlatformName)) return;
    const binary = koffiBinary(join(resources, "node_modules"), "win32", arch);
    if (!existsSync(binary)) throw new Error(`The packed app has no koffi: missing ${binary}`);
  };
}
