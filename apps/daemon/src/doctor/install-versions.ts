import type { Check } from "@ace/diagnostics";
import { ReleaseVersion } from "@ace/protocol";
import { isNewer } from "@ace/service/version";

/** The desktop app's bundle id, from its packaging config. */
const ACE_BUNDLE_ID = "dev.ace.app";

/** What a check reports. */
export type Verdict = Awaited<ReturnType<Check["run"]>>;

/** One piece of ace whose version is known. `version` is a release or "development". */
export type VersionSide = {
  kind: "cli" | "daemon" | "desktop";
  version: string;
  /** Where it lives, when that helps the person find it (an app bundle). */
  where?: string;
};

/** A string key from an XML plist, or undefined when it's missing or not a plain string. */
function plistString(text: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,200})</string>`).exec(text);
  return match?.[1]?.trim();
}

/**
 * The version an `Info.plist` records, when the bundle is ace's desktop app. Binary plists,
 * other apps and malformed versions give undefined.
 */
export function aceAppVersion(plist: string): string | undefined {
  if (plistString(plist, "CFBundleIdentifier") !== ACE_BUNDLE_ID) return undefined;
  return ReleaseVersion.safeParse(plistString(plist, "CFBundleShortVersionString")).data;
}

/**
 * Where the running CLI came from, read off its entry script's path: the desktop app's bundled
 * CLI (`…/ace.app/Contents/Resources/daemon/ace.mjs`) or an installed release
 * (`…/releases/<version>-<target>/ace.mjs`). Neither launcher sets `ACE_VERSION`.
 */
export function cliOrigin(
  entry: string | undefined,
): { kind: "app"; bundle: string } | { kind: "release"; version: string } | undefined {
  if (!entry) return undefined;
  const app = /^(.+\.app)\/Contents\/Resources\/daemon\/ace\.mjs$/.exec(entry);
  if (app?.[1]) return { kind: "app", bundle: app[1] };
  if (process.platform === "win32") {
    // `C:\Users\me\.ace\releases\<version>-win32-<arch>\ace.mjs`
    const windows = /[\\/]releases[\\/]([^\\/]+)-win32-(?:arm64|x64)[\\/]ace\.mjs$/i.exec(entry);
    const version = ReleaseVersion.safeParse(windows?.[1]).data;
    if (version) return { kind: "release", version };
  }
  const release = /\/releases\/([^/]+)-(?:darwin|linux)-(?:arm64|x64)\/ace\.mjs$/.exec(entry);
  const version = ReleaseVersion.safeParse(release?.[1]).data;
  return version ? { kind: "release", version } : undefined;
}

const names: Record<VersionSide["kind"], string> = {
  cli: "this ace command",
  daemon: "the running daemon",
  desktop: "the ace app",
};

function describe(side: VersionSide): string {
  const version = ReleaseVersion.safeParse(side.version).success
    ? side.version
    : "(a development build)";
  return `${names[side.kind]} ${version}${side.where ? ` (${side.where})` : ""}`;
}

function label(side: VersionSide): string {
  return `${names[side.kind]}${side.where ? ` (${side.where})` : ""}`;
}

function advice(side: VersionSide, newest: string): string {
  if (side.kind === "daemon")
    return `Restart the daemon on ${newest}: run ace stop, then reopen the ace app (update the app first if it is older).`;
  if (side.kind === "desktop")
    return `Update the ace app${side.where ? ` at ${side.where}` : ""} to ${newest}, or remove it if you no longer use it.`;
  return `Update this ace command to ${newest}, or run the newer one: check which ace is first on PATH (ace doctor --all lists them).`;
}

/**
 * Warns when release builds of the CLI, the daemon and the desktop app disagree, and names the
 * older ones to update. Development builds are listed but never compared.
 */
export function versionsVerdict(sides: readonly VersionSide[], daemonNote?: string): Verdict {
  const summary = [...sides.map(describe), ...(daemonNote ? [daemonNote] : [])].join(", ");
  const releases = sides.filter((side) => ReleaseVersion.safeParse(side.version).success);
  const newest = releases.reduce<string | undefined>(
    (best, side) => (best === undefined || isNewer(side.version, best) ? side.version : best),
    undefined,
  );
  const older = newest === undefined ? [] : releases.filter((side) => side.version !== newest);
  if (newest === undefined || older.length === 0) {
    const note = releases.length < sides.length ? ". Development builds aren't compared" : "";
    return {
      status: "ok",
      message: `${capitalize(summary)}${note}`,
      fix: "Nothing to do.",
    };
  }
  return {
    status: "warn",
    message: `${capitalize(summary)}. ${capitalize(older.map(label).join(" and "))} ${older.length === 1 ? "is" : "are"} older than ${newest}`,
    fix: [...new Set(older.map((side) => advice(side, newest)))].join(" "),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
