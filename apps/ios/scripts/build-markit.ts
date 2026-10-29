import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds markit's iOS core (`MarkitCore.xcframework`, Rust for the device and the simulator) from
 * the packages/markit submodule, and copies its licence notices into the Swift package's resource
 * bundle. The core rebuilds whenever the submodule commit, its local edits or MARKIT_FEATURES
 * change, so a submodule bump never links a stale core; otherwise only the notices are copied.
 * Generated, never committed (markit ignores both):
 *
 *   bun scripts/build-markit.ts
 *
 * Needs macOS with Xcode and Rust with the aarch64-apple-ios and aarch64-apple-ios-sim targets.
 */
const here = dirname(fileURLToPath(import.meta.url));
const markit = join(here, "..", "..", "..", "packages", "markit");
const artifacts = join(markit, "platforms", "ios", "Artifacts");
const framework = join(artifacts, "MarkitCore.xcframework");
const stampFile = join(artifacts, ".ace-build");

if (process.platform !== "darwin") {
  process.stderr.write("markit's iOS core builds on macOS only (Xcode and the iOS SDKs).\n");
  process.exit(1);
}

if (!existsSync(join(markit, "Cargo.toml"))) {
  process.stderr.write(
    "packages/markit is empty: run `git submodule update --init --recursive` first.\n",
  );
  process.exit(1);
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", markit, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
// The contents of local edits and new files, not just their names: a second edit to the same
// file, or a new source file, must rebuild too.
const edits = createHash("sha256").update(git("diff", "HEAD", "--binary"));
for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
  if (path)
    edits
      .update(path)
      .update("\0")
      .update(readFileSync(join(markit, path)))
      .update("\0");
}
const stamp = JSON.stringify({
  head: git("rev-parse", "HEAD").trim(),
  edits: edits.digest("hex"),
  features: process.env.MARKIT_FEATURES ?? "",
});
const built = existsSync(stampFile) ? readFileSync(stampFile, "utf8") : undefined;
const run = (script: string) =>
  execFileSync("bash", [join(markit, "scripts", script)], { cwd: markit, stdio: "inherit" });

if (existsSync(framework) && built === stamp) {
  run("package-notices.sh");
  console.log("markit's iOS core is current");
} else {
  try {
    // Also copies the notices.
    run("build-ios.sh");
  } catch (error) {
    process.stderr.write(
      "\nBuilding markit's iOS core failed. It needs Xcode and Rust with the iOS targets " +
        "(`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`).\n",
    );
    throw error;
  }
  writeFileSync(stampFile, stamp);
  console.log(`Built markit's iOS core at ${framework}`);
}
