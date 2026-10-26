import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

/**
 * Cases whose assertions are POSIX-only: `ps`/`lsof`, process groups, mode bits, FIFOs, `/`
 * paths, signals, Linux or macOS stand-ins written as shell scripts. Each workflow they cover
 * has a "Windows: ..." case that runs instead (lifecycle-processes, audio, video, profile-scope,
 * preview launch, engine-check), or is a Linux/macOS feature.
 */
const posixOnly = [
  // chrome-host: lsof
  "listens on no debugging port and writes no DevToolsActivePort",
  // lifecycle and io: `ps -axo`, `/player.html` paths
  "closes while an approval hook is still waiting and rejects that pending operation",
  "ace's browser exits once its last thread closes and the idle period passes",
  "persistent threads share ace's profile across browser restarts, private threads do not",
  "saves a timestamped frame manifest and a player and reports the recording artifact",
  "falls back to a playable sequence when an injected encoder process fails",
  "closes a thread even when the screencast stop is never answered",
  // engine-check: `#!/bin/sh` stand-in Chromium, Linux libraries and AppArmor
  "names the missing libraries and the install command when Chrome cannot load",
  "offers the AppArmor profile for the executable ace runs when the sandbox is blocked",
  "offers no profile once the one ace needs is installed, or where AppArmor doesn't restrict",
  "passes a Chromium that starts headless, and warns when it runs without its sandbox",
  "asks Ubuntu for the AppArmor profile but Arch only to drop the sandbox opt-out",
  "never offers an AppArmor profile for a blocked sandbox on a kernel without AppArmor",
  "fails a Chromium that starts but never opens a page",
  // audio: assumes the capture runs at the page's AudioContext rate
  "an unmuted viewer hears the page's tone as Opus, in step with the video; a muted one gets no audio bytes",
  // video: one evaluate holds the whole clip, larger than 64 KiB with Windows' software H.264
  "a viewer that asks for video starts at a keyframe sized for its screen, plays decodable video and never gets JPEG",
  // process-table: POSIX process groups (the Windows tree is a job: chrome-job.process.test.ts)
  "finds a detached process by its command line with its own process group",
  // profile-scope: `/` separator
  "ids that look like paths still name a profile inside ace's profiles folder",
  // browser-extension install: macOS/Linux manifests and mode bits
  "install writes a host manifest only for browsers that have run, naming only ace's extension",
  // preview: FIFOs, SIGKILL
  "FIFO launch configurations reject without occupying filesystem workers",
  "an oversized stdout line terminates its owned launch",
  "an oversized stderr line terminates its owned launch",
];
/** Windows ARM64 has no Chrome for Testing: ace runs the installed Chrome or Edge, never a download. */
const x64Only = [
  "says ace's Chrome downloads on first use before it has been downloaded",
  "an ace-owned first-use headless browser preserves the public policy, ref, screenshot and log contract",
];
const escape = (name: string) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
const excluded = [...posixOnly, ...(process.arch === "arm64" ? x64Only : [])];

// Every browser workflow's tests on native Windows: ace's own Chrome, Use my Chrome's extension
// and native host, browser annotation, dev-server preview and the desktop's embedded view. Runs after the Windows Chrome is
// prepared (`packages/browser/scripts/prepare-windows-test.ts`).
export default defineConfig({
  test: {
    ...native.test,
    include: [
      "packages/browser/src/**/*.test.ts",
      "packages/browser-extension/src/**/*.test.ts",
      "packages/browser-annotate/src/**/*.test.ts",
      "packages/preview/src/**/*.test.ts",
      // The desktop's embedded browser view, with real Chrome pages standing in for Electron's.
      "apps/desktop/src/main/browser/**/*.test.ts",
    ],
    // A full name ends with the case's own name; "Windows: ..." counterparts stay included.
    testNamePattern: new RegExp(`^(?!.*(?<!Windows: )(?:${excluded.map(escape).join("|")})$)`),
    maxWorkers: 2,
  },
});
