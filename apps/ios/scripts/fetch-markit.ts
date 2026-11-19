import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Puts markit's iOS Swift package, with its prebuilt core (`MarkitCore.xcframework`) and licence
 * notices, at `Vendor/Markit`, where project.yml points. It is markit's own release artifact,
 * pinned by version and SHA-256 below, so building the app needs no Rust:
 *
 *   bun scripts/fetch-markit.ts
 *
 * `ACE_MARKIT_IOS_ZIP=<path>` uses a local `markit-ios-<version>.zip` instead (one
 * `scripts/release.sh` in markit built), to try an unreleased markit. A download is checked
 * against the pinned hash; a local zip is used as it is.
 */
export const markitVersion = "0.1.0";
const pinnedSha256 = "c648f804cbf3cb80e18bc9d00bfa3cc956d9ef1480200172c7eac6da704edb9d";
const release = `https://github.com/arpan404/markit/releases/download/v${markitVersion}/markit-ios-${markitVersion}.zip`;

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(app, "Vendor");
const target = join(vendor, "Markit");
const stampFile = join(vendor, ".markit");
const local = process.env.ACE_MARKIT_IOS_ZIP;
const wanted = local ? `local:${local}` : `${markitVersion}:${pinnedSha256}`;

if (!local && existsSync(stampFile) && readFileSync(stampFile, "utf8") === wanted) {
  console.log(`markit ${markitVersion} for iOS is current`);
  process.exit(0);
}

mkdirSync(vendor, { recursive: true });
let zip: string;
if (local) zip = local;
else {
  const response = await fetch(release);
  if (!response.ok) throw new Error(`Downloading ${release} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pinnedSha256)
    throw new Error(`${release} has SHA-256 ${sha256}, expected ${pinnedSha256}`);
  zip = join(vendor, "markit-ios.zip");
  writeFileSync(zip, bytes);
}
// The archive holds `ios/` (markit's platforms/ios); unpack beside the target, then swap it in.
const scratch = join(vendor, ".unpack");
rmSync(scratch, { recursive: true, force: true });
execFileSync("/usr/bin/unzip", ["-q", zip, "-d", scratch]);
if (!existsSync(join(scratch, "ios", "Artifacts", "MarkitCore.xcframework", "Info.plist")))
  throw new Error(`${zip} holds no ios/Artifacts/MarkitCore.xcframework`);
rmSync(target, { recursive: true, force: true });
renameSync(join(scratch, "ios"), target);
rmSync(scratch, { recursive: true, force: true });
if (!local) rmSync(zip, { force: true });
writeFileSync(stampFile, wanted);
console.log(`markit ${local ? "from " + local : markitVersion} for iOS is at ${target}`);
