import { execFile } from "node:child_process";
import type { PrivilegedRunner } from "@ace/screen";

/**
 * The one privileged step of locked computer use: it places a signed authorization plug-in,
 * adds ace as ONE extra alternative of the `system.login.screensaver` right (Apple's own
 * mechanisms are never removed), and loads two root launch daemons — the authorization broker
 * and the independent relock guardian. Removal reverses exactly those additions.
 *
 * It changes this Mac's authorization policy, so it needs one administrator authorization and
 * the person's consent. The command text is assembled by the pure functions below so it can be
 * reviewed and unit-tested without running; the real executor presents a single admin prompt.
 * Nothing here ever stores or asks for the login password — macOS collects it.
 *
 * It activates only when the signed native artifacts are staged (see `privilegedRunnerFromEnv`);
 * when they are absent the daemon keeps the pending stub and the feature reports needs-approval.
 */

/** Where the components live once installed. Mirrors the read-only detector's constants. */
const bundleDestination = "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle";
const right = "system.login.screensaver";
const mechanism = "AceLockedUseAuthorization:permit";
const brokerLabel = "dev.ace.locked-use.authorization";
const guardianLabel = "dev.ace.locked-use.guardian";
const daemonDirectory = "/Library/LaunchDaemons";

/** The signed artifacts this ace ships, located by the host (the desktop app stages them). */
export interface LockedUseArtifacts {
  /** The signed `AceLockedUseAuthorization.bundle` built from native/locked-use. */
  pluginBundle: string;
  /** The `ace-locked-use-authority` broker executable. */
  brokerExecutable: string;
  /** The `ace-locked-use-guardian` executable. */
  guardianExecutable: string;
}

/** Runs one script with administrator rights through a single OS authorization. */
export interface AdminAuthorization {
  run(purpose: string, script: string): Promise<void>;
}

const daemonPlistPath = (label: string): string => `${daemonDirectory}/${label}.plist`;

/** A root LaunchDaemon that keeps one executable alive. Written by the install script. */
export function daemonPlist(label: string, executable: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${label}</string>`,
    `<key>ProgramArguments</key><array><string>${executable}</string></array>`,
    "<key>KeepAlive</key><true/>",
    "<key>RunAtLoad</key><true/>",
    "</dict></plist>",
  ].join("\n");
}

/**
 * Shell-quote one argument for POSIX `sh`. Single quotes with the standard `'\''` escape, so a
 * path can never break out of its quotes into another command.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The install script. Every step is idempotent and additive: a Python helper reads the current
 * `system.login.screensaver` right and inserts our mechanism only if it is not already an
 * alternative, leaving Apple's mechanisms and any other provider's untouched. The script fails
 * on the first error (`set -e`) so a half-finished install cannot report success; the daemon
 * re-detects afterwards and will not report `on` unless every component is proven valid.
 */
export function buildInstallScript(artifacts: LockedUseArtifacts): string {
  const plugin = shellQuote(artifacts.pluginBundle);
  const broker = shellQuote(artifacts.brokerExecutable);
  const guardian = shellQuote(artifacts.guardianExecutable);
  return [
    "set -e",
    'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
    // 1. Place the signed plug-in, replacing only our own previous copy.
    `rm -rf ${shellQuote(bundleDestination)}`,
    `mkdir -p ${shellQuote(daemonDirectory)} /Library/Security/SecurityAgentPlugins`,
    `cp -R ${plugin} ${shellQuote(bundleDestination)}`,
    `chown -R root:wheel ${shellQuote(bundleDestination)}`,
    `chmod -R 755 ${shellQuote(bundleDestination)}`,
    // 2. Add our mechanism as one more alternative of the screen-saver unlock right, additively.
    addMechanismStep(),
    // 3. Install and (re)load both root daemons.
    installDaemonStep(brokerLabel, broker),
    installDaemonStep(guardianLabel, guardian),
  ].join("\n");
}

/** The removal script: reverse exactly what install added, each step tolerant of partial state. */
export function buildRemoveScript(): string {
  return [
    'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
    removeDaemonStep(brokerLabel),
    removeDaemonStep(guardianLabel),
    removeMechanismStep(),
    `rm -rf ${shellQuote(bundleDestination)}`,
    "exit 0",
  ].join("\n");
}

/**
 * Reads the right with `security authorizationdb read`, adds our mechanism once via a small,
 * self-contained Python edit, and writes it back with `security authorizationdb write`. Apple's
 * mechanisms stay; a `k-of-n` or alternatives layout is preserved by only appending.
 */
function addMechanismStep(): string {
  return [
    `security authorizationdb read ${shellQuote(right)} > /tmp/ace-screensaver-right.plist`,
    `/usr/bin/python3 - ${shellQuote(mechanism)} < /tmp/ace-screensaver-right.plist > /tmp/ace-screensaver-right.next.plist <<'PY'`,
    "import sys, plistlib",
    "mechanism = sys.argv[1]",
    "right = plistlib.loads(sys.stdin.buffer.read())",
    "mechanisms = right.setdefault('mechanisms', [])",
    "if mechanism not in mechanisms: mechanisms.append(mechanism)",
    "sys.stdout.buffer.write(plistlib.dumps(right))",
    "PY",
    `security authorizationdb write ${shellQuote(right)} < /tmp/ace-screensaver-right.next.plist`,
    "rm -f /tmp/ace-screensaver-right.plist /tmp/ace-screensaver-right.next.plist",
  ].join("\n");
}

/** Removes only our mechanism from the right, leaving every other mechanism in place. */
function removeMechanismStep(): string {
  return [
    `security authorizationdb read ${shellQuote(right)} > /tmp/ace-screensaver-right.plist 2>/dev/null || exit 0`,
    `/usr/bin/python3 - ${shellQuote(mechanism)} < /tmp/ace-screensaver-right.plist > /tmp/ace-screensaver-right.next.plist <<'PY'`,
    "import sys, plistlib",
    "mechanism = sys.argv[1]",
    "right = plistlib.loads(sys.stdin.buffer.read())",
    "right['mechanisms'] = [m for m in right.get('mechanisms', []) if m != mechanism]",
    "sys.stdout.buffer.write(plistlib.dumps(right))",
    "PY",
    `security authorizationdb write ${shellQuote(right)} < /tmp/ace-screensaver-right.next.plist`,
    "rm -f /tmp/ace-screensaver-right.plist /tmp/ace-screensaver-right.next.plist",
  ].join("\n");
}

function installDaemonStep(label: string, executable: string): string {
  const plist = shellQuote(daemonPlistPath(label));
  return [
    `cat > ${plist} <<'PLIST'`,
    daemonPlist(label, stripQuotes(executable)),
    "PLIST",
    `chown root:wheel ${plist}`,
    `chmod 644 ${plist}`,
    `launchctl bootout system/${label} 2>/dev/null || true`,
    `launchctl bootstrap system ${plist}`,
  ].join("\n");
}

function removeDaemonStep(label: string): string {
  const plist = shellQuote(daemonPlistPath(label));
  return [`launchctl bootout system/${label} 2>/dev/null || true`, `rm -f ${plist}`].join("\n");
}

/** The plist embeds the raw executable path; it is validated before the script is built. */
function stripQuotes(quoted: string): string {
  return quoted.slice(1, -1).replaceAll(`'\\''`, "'");
}

/** A runner that refuses both actions when the staged artifact paths are unusable. */
const refuseInvalidArtifacts: PrivilegedRunner = {
  install: () => Promise.reject(new Error("Locked use components are staged at an invalid path.")),
  remove: () => Promise.reject(new Error("Locked use components are staged at an invalid path.")),
};

/** Rejects any artifact path that isn't an absolute, control-character-free POSIX path. */
function validArtifact(path: string): boolean {
  return (
    path.startsWith("/") &&
    path.length <= 4096 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(path)
  );
}

/**
 * The real privileged runner. `install`/`remove` each assemble one script and run it through a
 * single administrator authorization, then return; the caller (the installer) re-detects and
 * never trusts this result. It fails closed: a missing/odd artifact path or a non-zero script
 * exit rejects, leaving detection to report the true state.
 */
export function privilegedRunner(
  artifacts: LockedUseArtifacts,
  admin: AdminAuthorization,
): PrivilegedRunner {
  const paths = [artifacts.pluginBundle, artifacts.brokerExecutable, artifacts.guardianExecutable];
  if (!paths.every(validArtifact)) return refuseInvalidArtifacts;
  return {
    install: () => admin.run("install locked computer use", buildInstallScript(artifacts)),
    remove: () => admin.run("remove locked computer use", buildRemoveScript()),
  };
}

/**
 * Triggers one macOS administrator prompt for a script. The person approves it on the target
 * Mac; from a remote client the prompt still appears there. `osascript` collects the password
 * itself — ace never sees it.
 */
export function osascriptAdmin(): AdminAuthorization {
  return {
    run(purpose, script) {
      const wrapped = `do shell script ${appleScriptString(script)} with prompt ${appleScriptString(
        `ace wants to ${purpose}.`,
      )} with administrator privileges`;
      return new Promise((resolve, reject) => {
        execFile(
          "/usr/bin/osascript",
          ["-e", wrapped],
          { timeout: 120_000, maxBuffer: 256 * 1024, env: { PATH: "/usr/bin:/bin" } },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    },
  };
}

/** Quote a string as an AppleScript literal. */
export function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Builds the real runner from the artifact paths the desktop app stages in the environment, or
 * returns undefined when they are absent — in which case the daemon keeps the pending stub and
 * installing stays unavailable until the components ship and the person approves.
 */
export function privilegedRunnerFromEnv(env: NodeJS.ProcessEnv): PrivilegedRunner | undefined {
  const pluginBundle = env.ACE_LOCKED_USE_PLUGIN?.trim();
  const brokerExecutable = env.ACE_LOCKED_USE_BROKER?.trim();
  const guardianExecutable = env.ACE_LOCKED_USE_GUARDIAN?.trim();
  if (!pluginBundle || !brokerExecutable || !guardianExecutable) return undefined;
  return privilegedRunner({ pluginBundle, brokerExecutable, guardianExecutable }, osascriptAdmin());
}
