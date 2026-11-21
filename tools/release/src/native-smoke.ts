import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { stagedAceFiles } from "./ace-files.ts";
import { stagedAceHistory } from "./ace-history.ts";
import { stagedAceMedia } from "./ace-media.ts";
import {
  readScreenHelperIdentity,
  assertScreenHelperIdentity,
  type ScreenHelperIdentity,
} from "./screen-identity.ts";

type Target = z.infer<typeof ReleaseTarget>;

/** Runs a command with the shipped runtime; the caller checks what it printed. */
export const runShipped = (command: string, args: string[]) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

// codesign writes signature metadata to stderr.
const displayCodesign = (args: string[]) => {
  const result = spawnSync("codesign", args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout + result.stderr;
};

/**
 * Each native ace ships beside the daemon must carry the build's signature: signed, with the
 * hardened runtime and no entitlements of its own on macOS; Authenticode signed on Windows when
 * the build signs. The whole app's signature is checked once, before these.
 */
function assertSignedNatives(
  root: string,
  target: Target,
  options: { production: boolean; authenticode: boolean },
): void {
  const natives = [
    { label: "ace-media", path: stagedAceMedia(root, target) },
    { label: "ace-files", path: stagedAceFiles(root, target) },
    { label: "ace-history", path: stagedAceHistory(root, target) },
  ];
  if (target.startsWith("darwin-"))
    for (const native of natives) {
      runShipped("codesign", ["--verify", "--strict", native.path]);
      const metadata = displayCodesign(["-dvv", native.path]);
      if (!metadata.includes("runtime")) throw new Error(`${native.label} lacks hardened runtime`);
      if (options.production && !metadata.includes("Authority=Developer ID Application:"))
        throw new Error(`${native.label} lacks Developer ID`);
      if (displayCodesign(["-d", "--entitlements", ":-", native.path]).includes("<key>"))
        throw new Error(`${native.label} must have no entitlements`);
    }
  else if (target.startsWith("win32-") && options.authenticode)
    for (const native of natives) runShipped("signtool", ["verify", "/pa", native.path]);
}

/** Verifies the signature of the natives in a packaged desktop app, and the screen helper's. */
export async function verifyDesktopNatives(
  app: string,
  target: Target,
  identityFile: string,
  options: { production: boolean; authenticode: boolean; screenIdentity?: ScreenHelperIdentity },
): Promise<void> {
  const resources = target.startsWith("darwin-")
    ? join(app, "Contents/Resources")
    : join(app, "resources");
  if (target.startsWith("darwin-")) runShipped("codesign", ["--verify", "--deep", "--strict", app]);
  assertSignedNatives(resources, target, options);
  if (!target.startsWith("darwin-")) return;
  const identity = readScreenHelperIdentity(join(app, "Contents/Helpers/AceScreenHelper.app"));
  if (options.screenIdentity) assertScreenHelperIdentity(options.screenIdentity, identity);
  else if (!options.production)
    throw new Error("Local desktop smoke needs the staged screen helper identity");
  if (options.production && identity.requirement !== (await readFile(identityFile, "utf8")).trim())
    throw new Error("Screen helper production identity changed");
  if (options.production) {
    runShipped("spctl", ["--assess", "--type", "execute", app]);
    runShipped("xcrun", ["stapler", "validate", app]);
  }
}
