import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const unsigned = process.argv.includes("--unsigned");
const team = process.env.ACE_IOS_TEAM_ID;
if (!unsigned && !team)
  throw new Error(
    "Set ACE_IOS_TEAM_ID to your Apple Developer team, or pass --unsigned for local archive verification.",
  );
const archive = resolve(process.env.ACE_IOS_ARCHIVE ?? `${root}/.build/Ace.xcarchive`);
const generated = spawnSync("bun", ["run", "generate"], { cwd: root, stdio: "inherit" });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const build = spawnSync(
  "xcodebuild",
  [
    "-project",
    "Ace.xcodeproj",
    "-scheme",
    "Ace",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-jobs",
    "4",
    "archive",
    ...(unsigned
      ? ["CODE_SIGNING_ALLOWED=NO"]
      : ["CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${team}`]),
    `CURRENT_PROJECT_VERSION=${process.env.ACE_IOS_BUILD_NUMBER ?? "1"}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(
  unsigned
    ? `Unsigned archive verified: ${archive}. This cannot be uploaded to TestFlight.`
    : `Signed archive: ${archive}. Validate and distribute it through Xcode Organizer.`,
);
