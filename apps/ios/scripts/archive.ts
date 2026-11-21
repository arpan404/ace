import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { releasePlan } from "./release-plan.ts";

/**
 * Archives the iOS app, and with `--upload` sends it to App Store Connect. `release-plan.ts`
 * decides the commands; this runs them. See docs/releasing-ios-app-store.md.
 */
const root = resolve(import.meta.dirname, "..");
const plan = releasePlan({
  argv: process.argv.slice(2),
  env: process.env,
  root,
  nowMs: Date.now(),
});

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `Archiving ace for iOS (${plan.mode}), version ${plan.version ?? "from project.yml"}, build ${plan.buildNumber}.`,
);
run("bun", ["run", "generate"]);
if (plan.ownsArchive) rmSync(plan.archivePath, { recursive: true, force: true });
else if (existsSync(plan.archivePath)) {
  console.error(
    `${plan.archivePath} already exists. Remove it or set ACE_IOS_ARCHIVE to a new path.`,
  );
  process.exit(1);
}
run("xcodebuild", plan.archiveArgs);

if (plan.upload) {
  const { exportPath, optionsPath, options, args } = plan.upload;
  mkdirSync(dirname(optionsPath), { recursive: true });
  writeFileSync(optionsPath, options);
  rmSync(exportPath, { recursive: true, force: true });
  run("xcodebuild", args);
  console.log(
    `Uploaded build ${plan.buildNumber} to App Store Connect. It shows in TestFlight once Apple has processed it.`,
  );
} else {
  console.log(
    plan.mode === "unsigned"
      ? `Unsigned archive verified: ${plan.archivePath}. This cannot be uploaded to TestFlight.`
      : `Signed archive: ${plan.archivePath}. Validate and distribute it through Xcode Organizer, or run with --upload.`,
  );
}
