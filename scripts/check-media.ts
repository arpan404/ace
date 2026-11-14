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
  // E3b: an Android emulator's host-encoded picture through the binary and back.
  if (process.platform === "darwin")
    execFileSync(
      "bun",
      ["--bun", "x", "vitest", "run", "src/frame-encoder-media.process.test.ts"],
      {
        cwd: new URL("../packages/devices/", import.meta.url),
        env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
        stdio: "inherit",
      },
    );
  // E3: the Mac screen helper keeps its signing identity, and (with ACE_SCREEN_INTEGRATION=1,
  // which shows a fixture window) streams through this binary and back on egress.
  if (process.platform === "darwin")
    execFileSync(
      "bun",
      [
        "--bun",
        "x",
        "vitest",
        "run",
        "src/helper-identity.native.process.test.ts",
        "src/media-ingest.native.process.test.ts",
        "src/media-backlog.process.test.ts",
      ],
      {
        cwd: new URL("../packages/screen/", import.meta.url),
        env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
        stdio: "inherit",
      },
    );
}
