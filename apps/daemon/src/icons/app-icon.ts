import { execFile } from "node:child_process";

/*
 * A native app's icon on the daemon's host, where computer use runs: never on whichever client
 * happens to look. macOS finds the app by bundle id with Spotlight and draws its Finder icon
 * through NSWorkspace, which handles asset-catalog icons too. Other platforms have no reader
 * yet, and their rows keep the generic app glyph. The process runner is injected.
 */

export type Run = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<string>;

export const runFile: Run = (file, args, options) =>
  new Promise((resolve, reject) =>
    execFile(file, [...args], options, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );

// Draws the OS image at 64px; this never opens the app or reads its bundle resources.
const drawIcon = `ObjC.import('AppKit');
function run(argv) {
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64));
  image.lockFocus;
  icon.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  image.unlockFocus;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSPNGFileType, $.NSDictionary.dictionary);
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}`;

/** Bundle ids are reverse-DNS names; nothing else reaches the Spotlight query. */
const bundleId = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

/**
 * The app's icon as PNG bytes. Null when the host has no such app or no reader for its platform;
 * undefined when the lookup failed in a way that may pass.
 */
export async function appIcon(
  identity: string,
  options: { platform: NodeJS.Platform; run: Run },
): Promise<Buffer | null | undefined> {
  if (options.platform !== "darwin" || !bundleId.test(identity)) return null;
  let path: string | undefined;
  try {
    const found = await options.run(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == "${identity}"`],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    path = found.split("\n").find((line) => line.startsWith("/") && line.endsWith(".app"));
  } catch {
    return undefined;
  }
  if (!path) return null;
  try {
    const encoded = await options.run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", drawIcon, path],
      { timeout: 5000, maxBuffer: 256 * 1024 },
    );
    const bytes = Buffer.from(encoded.trim(), "base64");
    return bytes.length ? bytes : null;
  } catch {
    return undefined;
  }
}
