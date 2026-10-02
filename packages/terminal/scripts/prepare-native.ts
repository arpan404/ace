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
