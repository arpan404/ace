// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = new URL("../native/media/", import.meta.url);

// Clippy's lints change between Rust releases, so cargo runs on the toolchain the workspace pins,
// not whichever cargo comes first on PATH (Homebrew's, say).
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(new URL("rust-toolchain.toml", cwd), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/media/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup) {
  const version = spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.warn(
    `check:media: rustup not found, so running ${version || "cargo"}, not the pinned ${pinned}`,
  );
}
function cargo(args: string[]): void {
  if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, stdio: "inherit" });
  else execFileSync("cargo", args, { cwd, stdio: "inherit" });
}

for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  ["deny", "check", "licenses", "sources"],
]) {
  cargo(args);
}

// The daemon's supervisor, the egress route, the recording route and delivery against the binary
// just built: the acceptance tests for the process core, G1, F1 and D1. Windows runs the supervisor and
// egress tests over its named pipes; it has no recorder yet, and the producer suites below
// haven't been run against the Windows binary.
if (process.platform === "win32") {
  cargo(["build", "--locked", "-p", "ace-media"]);
  const binary = fileURLToPath(new URL("target/debug/ace-media.exe", cwd));
  execFileSync(
    "bun",
    ["--bun", "x", "vitest", "run", "src/supervisor.process.test.ts", "src/egress.process.test.ts"],
    {
      cwd: new URL("../packages/media/", import.meta.url),
      env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
      stdio: "inherit",
    },
  );
} else {
  cargo(["build", "--locked", "-p", "ace-media"]);
  const binary = fileURLToPath(new URL("target/debug/ace-media", cwd));
  const tests = [
    "src/supervisor.process.test.ts",
    "src/egress.process.test.ts",
    "src/recordings.process.test.ts",
    // D1: a tab, a screen and a device on one media connection, revocation and restart.
    "src/media-delivery.process.test.ts",
    // X4 (ADR 0201): every image vector through the binary and the lanes, lazy start, a kill.
    "src/images.process.test.ts",
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
  // X4 (ADR 0201): attachment previews and an oversized model image through the binary.
  execFileSync(
    "bun",
    [
      "--bun",
      "x",
      "vitest",
      "run",
      "src/attachment-thumbnail.test.ts",
      "src/model-image.process.test.ts",
    ],
    {
      cwd: new URL("../packages/context/", import.meta.url),
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
  // X2: a JPEG-only screen's video back from a killed ace-media through the real restart, its
  // pictures encoded by the new process (p95 under 2 s).
  execFileSync("bun", ["--bun", "x", "vitest", "run", "src/picture-restart.process.test.ts"], {
    cwd: new URL("../packages/screen/", import.meta.url),
    env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
    stdio: "inherit",
  });
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
  // E2: the Linux screen streams through this binary and back on egress (with
  // ACE_SCREEN_INTEGRATION=1 and ACE_LINUX_HELPER, inside a GNOME Wayland session).
  if (process.platform === "linux")
    execFileSync("bun", ["--bun", "x", "vitest", "run", "src/media-ingest.linux.process.test.ts"], {
      cwd: new URL("../packages/screen/", import.meta.url),
      env: { ...process.env, ACE_MEDIA_TEST_BINARY: binary },
      stdio: "inherit",
    });
}
