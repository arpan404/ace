#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseBetaTag } from "@ace/service/release-line";
import { daemonTargetsFor } from "../../src/packaging/release-plan.ts";
import { desktop, repo } from "../common.ts";
import { output, say, step, tagArgument } from "./github.ts";

/**
 * Builds this host's part of a release (ADR 0186) and stages it under `dist/releases/<tag>`:
 *
 *   node apps/desktop/scripts/pipeline/build.ts <tag>
 *
 * A beta tag runs `release:beta build --tag <tag>`; a stable tag runs `release:build <version>`,
 * with the signed standalone daemon archive on hosts that ship one (macOS arm64, Linux). Both
 * keep every check they already make: the packaged app's launch and probe-worker check, the
 * daemon archive's entry limit, its smoke test before and after signing. The tag has already
 * passed `prepare.ts`; these scripts check it again against the checked-out tree. Output:
 * `staged`, the folder to upload.
 */
step(async () => {
  const tag = tagArgument();
  const node = process.execPath;
  const env = { ...process.env };
  // An ACE_VERSION inherited from a running ace must not leak into the package.
  delete env.ACE_VERSION;
  const exec = (args: string[]) => execFileSync(node, args, { cwd: repo, stdio: "inherit", env });
  if (parseBetaTag(tag)) {
    exec([join(desktop, "scripts/release-beta.ts"), "build", "--tag", tag]);
  } else {
    const version = tag.replace(/^v/, "");
    const daemon = shipsDaemon() ? ["--with-daemon"] : [];
    say(`stable ${version}${daemon.length ? " with the standalone daemon" : ""}`);
    exec([join(desktop, "scripts/release.ts"), "build", version, ...daemon]);
  }
  output("staged", join(repo, "dist/releases", tag));
});

function shipsDaemon(): boolean {
  try {
    return daemonTargetsFor(process.platform, process.arch).length > 0;
  } catch {
    return false;
  }
}
