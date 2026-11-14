// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = new URL("../native/media/", import.meta.url);
for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  ["deny", "check", "licenses", "sources"],
]) {
  execFileSync("cargo", args, { cwd, stdio: "inherit" });
}

// The daemon's supervisor, the egress route and the recording route against the binary just
// built: the acceptance tests for the process core, G1 and F1. Windows has no lanes in the
// binary yet.
if (process.platform !== "win32") {
  execFileSync("cargo", ["build", "--locked", "-p", "ace-media"], { cwd, stdio: "inherit" });
  const binary = fileURLToPath(new URL("target/debug/ace-media", cwd));
  const tests = [
    "src/supervisor.process.test.ts",
    "src/egress.process.test.ts",
    "src/recordings.process.test.ts",
  ];
  execFileSync("bun", ["--bun", "x", "vitest", "run", ...tests], {
    cwd: new URL("../packages/media/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
  // E4: ace's Chrome streaming through the video extension into the binary and back on egress
  // (skipped where no Chrome is installed).
  execFileSync("bun", ["--bun", "x", "vitest", "run", "src/media-video.process.test.ts"], {
    cwd: new URL("../packages/browser/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
}
