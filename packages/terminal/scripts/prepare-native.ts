import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0's macOS prebuild tarball ships spawn-helper without execute bits.
// Source builds already have the correct mode. Fix both paths after Bun installs.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const directory of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = join(root, directory, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// This standalone POSIX helper uses no Node ABI and no third-party library.
// Compile at install alongside node-pty's existing C/C++ toolchain requirement.
if (process.platform !== "win32") {
  const source = fileURLToPath(new URL("../native/group-keeper.c", import.meta.url));
  const output = fileURLToPath(new URL("../native/group-keeper", import.meta.url));
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", source, "-o", output]);
}
