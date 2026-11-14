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

// The daemon's supervisor against the binary just built: the acceptance test for the process
// core. Windows has no lanes in the binary yet.
if (process.platform !== "win32") {
  execFileSync("cargo", ["build", "--locked", "-p", "ace-media"], { cwd, stdio: "inherit" });
  const binary = fileURLToPath(new URL("target/debug/ace-media", cwd));
  execFileSync("bun", ["--bun", "x", "vitest", "run", "src/supervisor.process.test.ts"], {
    cwd: new URL("../packages/media/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
}
