import { execFile } from "node:child_process";
import { z } from "zod";
import { AppIdentity, AppIdentityRequest } from "../../shared/contract.ts";
const application = z.object({
  path: z.string().startsWith("/").max(4096),
  displayName: z.string().min(1).max(256),
});
export interface ApplicationLookup {
  application(bundleId: string): Promise<z.infer<typeof application> | null>;
  icon(path: string): Promise<string | null>;
}
const pngIcon = AppIdentity.unwrap().shape.icon.unwrap();
/** Bounded cache includes missing apps and concurrent requests. */
export function appIdentities(lookup: ApplicationLookup) {
  const cache = new Map<string, Promise<z.infer<typeof AppIdentity>>>();
  let active = 0;
  async function read(bundleId: string): Promise<z.infer<typeof AppIdentity>> {
    active++;
    try {
      const found = application.nullable().parse(await lookup.application(bundleId));
      if (!found) return null;
      let icon: string | null = null;
      try {
        icon = pngIcon.nullable().parse(await lookup.icon(found.path));
      } catch {
        /* A name remains useful when the OS has no icon. */
      }
      return { bundleId, displayName: found.displayName, icon };
    } catch {
      return null;
    } finally {
      active--;
    }
  }
  return (bundleId: string) => {
    const checked = AppIdentityRequest.parse({ bundleId });
    const existing = cache.get(checked.bundleId);
    if (existing) return existing;
    if (active >= 8) return Promise.resolve(null);
    if (cache.size >= 256) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const pending = read(checked.bundleId);
    cache.set(checked.bundleId, pending);
    return pending;
  };
}

// NSWorkspace supplies the app's Finder icon. Electron's getFileIcon can return the same
// generic application icon for different bundles on macOS. Draw the OS image at a bounded
// size; this never opens the app or reads its bundle resources.
const iconScript = `ObjC.import('AppKit');
function run(argv) {
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
  image.lockFocus;
  icon.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  image.unlockFocus;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
  return 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}`;
export function systemApplicationIcon(
  path: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", iconScript, path],
      { timeout: 5000, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        const result = error ? undefined : pngIcon.safeParse(stdout.trim());
        resolve(result?.success ? result.data : null);
      },
    ),
  );
}

// Launch Services resolves bundle IDs, including apps outside /Applications. Arguments never
// become script source. This asks the system for metadata only, without opening the app.
const script = `ObjC.import('AppKit');
function run(argv) {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  const path = ObjC.unwrap(url.path);
  if (typeof path !== 'string' || !path) return 'null';
  const label = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path));
  const name = label.endsWith('.app') ? label.slice(0, -4) : label;
  return JSON.stringify({path: path, displayName: name});
}`;
export function systemApplication(
  bundleId: string,
  platform: NodeJS.Platform,
): Promise<z.infer<typeof application> | null> {
  if (platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, bundleId],
      { timeout: 5000, maxBuffer: 8192 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(application.nullable().parse(JSON.parse(stdout)));
        } catch {
          resolve(null);
        }
      },
    ),
  );
}
