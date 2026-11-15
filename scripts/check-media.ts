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

// The daemon's supervisor, the egress route, the recording route and delivery against the binary
// just built: the acceptance tests for the process core, G1, F1 and D1. Windows has no lanes in the
// binary yet.
if (process.platform !== "win32") {
  execFileSync("cargo", ["build", "--locked", "-p", "ace-media"], { cwd, stdio: "inherit" });
  const binary = fileURLToPath(new URL("target/debug/ace-media", cwd));
  const tests = [
    "src/supervisor.process.test.ts",
    "src/egress.process.test.ts",
    "src/recordings.process.test.ts",
    // D1: a tab, a screen and a device on one media connection, revocation and restart.
    "src/media-delivery.process.test.ts",
  ];
  execFileSync("bun", ["--bun", "x", "vitest", "run", ...tests], {
    cwd: new URL("../packages/media/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
  // D2: a relay media stream through the self-hosted relay and the binary, handed over with its
  // keys, the relay negative authorization cases, revocation and kill deadlines, and wss://
  // with its certificate refusals.
  execFileSync(
    "bun",
    [
      "--bun",
      "x",
      "vitest",
      "run",
      "src/media-relay/relay-media.process.test.ts",
      "src/media-relay/relay-media-tls.process.test.ts",
    ],
    {
      cwd: new URL("../apps/daemon/", import.meta.url),
      env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
      stdio: "inherit",
    },
  );
  // E4: ace's Chrome streaming through the video extension into the binary and back on egress
  // (skipped where no Chrome is installed).
  execFileSync("bun", ["--bun", "x", "vitest", "run", "src/media-video.process.test.ts"], {
    cwd: new URL("../packages/browser/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
  // E3b: a Simulator read by the binary itself, an Android device's scrcpy units forwarded by
  // the daemon, and (on a Mac) an emulator's host-encoded picture, through the binary and back.
  execFileSync(
    "bun",
    [
      "--bun",
      "x",
      "vitest",
      "run",
      "src/simulator-media.process.test.ts",
      "src/scrcpy-media.process.test.ts",
      ...(process.platform === "darwin"
        ? [
            "src/frame-encoder-media.process.test.ts",
            "src/simulator-transcode-media.process.test.ts",
          ]
        : []),
    ],
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
