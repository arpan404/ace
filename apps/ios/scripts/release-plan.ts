/**
 * What `archive.ts` runs, decided from its flags and environment with no I/O, so every
 * combination can be tested without Xcode. Three modes:
 *
 * - `--unsigned`: a Release archive with signing off, to check the app archives.
 * - default: a signed Release archive for Xcode Organizer (needs `ACE_IOS_TEAM_ID`).
 * - `--upload`: a signed archive, then `xcodebuild -exportArchive` uploads it to App Store
 *   Connect (TestFlight). Needs the team and an App Store Connect API key, which also lets
 *   automatic signing create the certificates and profiles it needs on a clean machine (CI).
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface ReleasePlan {
  mode: "unsigned" | "signed" | "upload";
  archivePath: string;
  archiveArgs: string[];
  /** Only for `upload`: the `-exportArchive` call and the options plist it reads. */
  upload?: { exportPath: string; optionsPath: string; options: string; args: string[] };
  version: string | undefined;
  buildNumber: string;
}

const semver = /^\d+\.\d+\.\d+$/;
/** One to three whole numbers joined by dots, as CFBundleVersion takes. */
const buildNumber = /^\d{1,9}(\.\d{1,9}){0,2}$/;

/**
 * `YYYYMMDD.HHmmss` in UTC: App Store Connect compares each part as a number, so a later build
 * is always higher, from any Mac or CI run, and two differ unless started in the same second.
 */
export function timestampBuildNumber(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, "");
  return stamp.replace("T", ".");
}

/** The App Store Connect API key, when all three parts are set; an error when only some are. */
function apiKey(env: Env): string[] | undefined {
  const path = env.APPLE_API_KEY?.trim();
  const id = env.APPLE_API_KEY_ID?.trim();
  const issuer = env.APPLE_API_ISSUER?.trim();
  if (!path && !id && !issuer) return undefined;
  if (!path || !id || !issuer)
    throw new Error(
      "Set all of APPLE_API_KEY (the .p8 file's path), APPLE_API_KEY_ID and APPLE_API_ISSUER, or none.",
    );
  return [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    path,
    "-authenticationKeyID",
    id,
    "-authenticationKeyIssuerID",
    issuer,
  ];
}

/** App Store Connect export options: upload, automatic signing, symbols included. */
export function exportOptions(team: string): string {
  const entries: [string, string | boolean][] = [
    ["method", "app-store-connect"],
    ["destination", "upload"],
    ["teamID", team],
    ["signingStyle", "automatic"],
    ["uploadSymbols", true],
    ["manageAppVersionAndBuildNumber", false],
  ];
  const body = entries
    .map(([key, value]) =>
      typeof value === "boolean"
        ? `  <key>${key}</key>\n  <${value}/>`
        : `  <key>${key}</key>\n  <string>${value}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

export function releasePlan(input: {
  argv: readonly string[];
  env: Env;
  /** `apps/ios`. */
  root: string;
  nowMs: number;
}): ReleasePlan {
  const { argv, env, root } = input;
  const unsigned = argv.includes("--unsigned");
  const uploading = argv.includes("--upload");
  if (unsigned && uploading) throw new Error("--unsigned and --upload can't be used together.");
  const mode = unsigned ? "unsigned" : uploading ? "upload" : "signed";

  const team = env.ACE_IOS_TEAM_ID?.trim() ?? "";
  if (mode !== "unsigned" && !team)
    throw new Error(
      "Set ACE_IOS_TEAM_ID to your Apple Developer team, or pass --unsigned for local archive verification.",
    );
  const key = mode === "unsigned" ? undefined : apiKey(env);
  if (mode === "upload" && !key)
    throw new Error(
      "--upload needs an App Store Connect API key: set APPLE_API_KEY (the .p8 file's path), APPLE_API_KEY_ID and APPLE_API_ISSUER.",
    );

  const versionInput = env.ACE_IOS_VERSION?.trim() ?? "";
  const version = versionInput.replace(/^ios-v|^v/, "") || undefined;
  if (versionInput && !(version && semver.test(version)))
    throw new Error(`ACE_IOS_VERSION must look like 1.2.3 or ios-v1.2.3, not "${versionInput}".`);
  const build =
    env.ACE_IOS_BUILD_NUMBER?.trim() ||
    (mode === "upload" ? timestampBuildNumber(input.nowMs) : "1");
  if (!buildNumber.test(build))
    throw new Error(`ACE_IOS_BUILD_NUMBER must be a whole number, not "${build}".`);

  // Remote push needs a paid team's `aps-environment`; an App Store build has one, so upload
  // turns it on unless ACE_PUSH says otherwise. Other builds keep it off unless asked.
  const push = env.ACE_PUSH?.trim().toUpperCase() || (mode === "upload" ? "YES" : "NO");
  if (push !== "YES" && push !== "NO")
    throw new Error(`ACE_PUSH must be YES or NO, not "${push}".`);

  // archive.ts replaces whatever is at this path, so it must name an archive.
  const archivePath = env.ACE_IOS_ARCHIVE?.trim() || `${root}/.build/Ace.xcarchive`;
  if (!archivePath.endsWith(".xcarchive"))
    throw new Error(`ACE_IOS_ARCHIVE must end in .xcarchive, not "${archivePath}".`);
  const archiveArgs = [
    "-project",
    "Ace.xcodeproj",
    "-scheme",
    "Ace",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archivePath,
    "-jobs",
    "4",
    "archive",
    ...(mode === "unsigned"
      ? ["CODE_SIGNING_ALLOWED=NO"]
      : ["CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${team}`]),
    `ACE_PUSH=${mode === "unsigned" ? "NO" : push}`,
    `CURRENT_PROJECT_VERSION=${build}`,
    ...(version ? [`MARKETING_VERSION=${version}`] : []),
    ...(key ?? []),
  ];
  if (mode !== "upload" || !key)
    return { mode, archivePath, archiveArgs, buildNumber: build, version };

  // The script's own folders, which it replaces on every run.
  const exportPath = `${root}/.build/export`;
  const optionsPath = `${root}/.build/ExportOptions.plist`;
  return {
    mode,
    archivePath,
    archiveArgs,
    buildNumber: build,
    version,
    upload: {
      exportPath,
      optionsPath,
      options: exportOptions(team),
      args: [
        "-exportArchive",
        "-archivePath",
        archivePath,
        "-exportPath",
        exportPath,
        "-exportOptionsPlist",
        optionsPath,
        ...key,
      ],
    },
  };
}
