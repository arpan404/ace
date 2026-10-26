import { execFile } from "node:child_process";
import type { PrivilegedRunner } from "@ace/screen";

/**
 * The one privileged step of locked computer use. It copies the signed components to
 * root-owned locations, verifies their signature against ace's pinned team, adds ace as ONE
 * extra alternative of the `system.login.screensaver` right by naming a dedicated
 * evaluate-mechanisms right in that right's `rule` list (Apple's own alternatives are never
 * touched, and the right's `mechanisms` key is never written), and loads two root launch
 * daemons — the authorization broker and the independent relock guardian. Removal reverses
 * exactly those additions.
 *
 * It changes this Mac's authorization policy, so it needs one administrator authorization and
 * the person's consent. The command text is assembled by the pure functions below so it can be
 * reviewed and unit-tested without running; the real executor presents a single admin prompt.
 * Nothing here stores or asks for the login password — macOS collects it.
 *
 * Why a separate right, not a `mechanisms` append: `system.login.screensaver` is a `rule`-class
 * right whose `rule` is an OR (`k-of-n` 1). A `mechanisms` key on a rule-class right is ignored,
 * and ANDing a mechanism onto a mechanisms-class right would deny ordinary password unlock. A
 * named alternative sub-right is the supported, additive, non-blocking shape; install refuses
 * unless the right is `class rule` with `k-of-n` 1, so it can never break manual unlock.
 */

const bundleDestination = "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle";
/** Root-owned home for the two daemon executables; never a user-writable app directory. */
const installRoot = "/Library/Application Support/dev.ace.locked-use";
const brokerDestination = `${installRoot}/ace-locked-use-authority`;
const guardianDestination = `${installRoot}/ace-locked-use-guardian`;
const screensaverRight = "system.login.screensaver";
/** The dedicated evaluate-mechanisms right that runs our plug-in; named in the rule above. */
const permitRight = "dev.ace.locked-use.permit";
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
  /** ace's pinned Developer ID team; the copies are signature-checked against it before use. */
  team: string;
}

/** Runs one script with administrator rights through a single OS authorization. */
export interface AdminAuthorization {
  run(purpose: string, script: string): Promise<void>;
}

const daemonPlistPath = (label: string): string => `${daemonDirectory}/${label}.plist`;

/** Escape a value for an XML text node, so a path with `&`, `<` or `>` cannot break the plist. */
function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A root LaunchDaemon that keeps one executable alive. Written by the install script. */
export function daemonPlist(label: string, executable: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xmlEscape(label)}</string>`,
    `<key>ProgramArguments</key><array><string>${xmlEscape(executable)}</string></array>`,
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

/** The codesign requirement a staged copy must satisfy before root runs or trusts it. */
function signingRequirement(team: string, identifier: string): string {
  return `anchor apple generic and certificate leaf[subject.OU] = ${JSON.stringify(team)} and identifier ${JSON.stringify(identifier)}`;
}

/** Copy to a root-owned path, then verify its signature; a failed check aborts the script. */
function stageSignedStep(source: string, destination: string, requirement: string): string {
  const to = shellQuote(destination);
  return [
    `rm -rf ${to}`,
    `cp -R ${shellQuote(source)} ${to}`,
    `chown -R root:wheel ${to}`,
    `chmod -R 755 ${to}`,
    `codesign --verify --strict -R ${shellQuote(`=${requirement}`)} ${to}`,
  ].join("\n");
}

/**
 * The install script. `set -e` aborts on the first failure, so a half-finished install cannot
 * report success; the daemon re-detects afterwards and will not report `on` unless every
 * component is proven valid. Temp files live in a fresh root-owned 0700 directory (never fixed
 * `/tmp` paths a same-user process could pre-create or symlink). Each copied component is
 * signature-checked before the rule is written or any daemon is bootstrapped.
 */
export function buildInstallScript(artifacts: LockedUseArtifacts): string {
  const { team } = artifacts;
  return [
    "set -e",
    "umask 077",
    'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
    'work="$(mktemp -d /tmp/ace-locked-use.XXXXXX)"',
    "trap 'rm -rf \"$work\"' EXIT",
    `mkdir -p ${shellQuote(installRoot)} ${shellQuote(daemonDirectory)} /Library/Security/SecurityAgentPlugins`,
    `chown root:wheel ${shellQuote(installRoot)}`,
    `chmod 755 ${shellQuote(installRoot)}`,
    // 1. Stage every component to a root-owned path and verify its signature before trusting it.
    stageSignedStep(
      artifacts.pluginBundle,
      bundleDestination,
      signingRequirement(team, "dev.ace.locked-use.authorization-plugin"),
    ),
    stageSignedStep(
      artifacts.brokerExecutable,
      brokerDestination,
      signingRequirement(team, "dev.ace.locked-use.authority"),
    ),
    stageSignedStep(
      artifacts.guardianExecutable,
      guardianDestination,
      signingRequirement(team, "dev.ace.locked-use.guardian"),
    ),
    // 2. Add ace as one named alternative of the screen-saver unlock right, additively.
    addRuleAlternativeStep(),
    // 3. Load both root daemons from their verified, root-owned copies.
    installDaemonStep(brokerLabel, brokerDestination),
    installDaemonStep(guardianLabel, guardianDestination),
  ].join("\n");
}

/** The removal script: reverse exactly what install added, each step tolerant of partial state. */
export function buildRemoveScript(): string {
  return [
    'export PATH="/usr/bin:/bin:/usr/sbin:/sbin"',
    "umask 077",
    'work="$(mktemp -d /tmp/ace-locked-use.XXXXXX)"',
    "trap 'rm -rf \"$work\"' EXIT",
    removeDaemonStep(brokerLabel),
    removeDaemonStep(guardianLabel),
    removeRuleAlternativeStep(),
    `security authorizationdb remove ${shellQuote(permitRight)} 2>/dev/null || true`,
    `rm -rf ${shellQuote(bundleDestination)} ${shellQuote(brokerDestination)} ${shellQuote(guardianDestination)}`,
    "exit 0",
  ].join("\n");
}

/**
 * Defines the evaluate-mechanisms `permit` right (idempotent) and inserts its NAME into the
 * screen-saver right's `rule` list. The edit reads the right from a file argv (not stdin, so it
 * cannot collide with the `python3 -` program heredoc), refuses unless the right is `class rule`
 * with `k-of-n` 1, and appends our name only if absent — Apple's alternatives are untouched.
 */
function addRuleAlternativeStep(): string {
  return [
    // Define the sub-right that actually evaluates our mechanism.
    `cat > "$work/permit.plist" <<'PLIST'`,
    permitRightPlist(),
    "PLIST",
    `security authorizationdb write ${shellQuote(permitRight)} < "$work/permit.plist"`,
    // Add its name to the screen-saver right's OR-rule, guarded on class and k-of-n.
    `security authorizationdb read ${shellQuote(screensaverRight)} > "$work/right.plist"`,
    `/usr/bin/python3 - ${shellQuote(permitRight)} "$work/right.plist" "$work/right.next.plist" <<'PY'`,
    "import sys, plistlib",
    "name = sys.argv[1]",
    "with open(sys.argv[2], 'rb') as handle: right = plistlib.loads(handle.read())",
    "if right.get('class') != 'rule' or right.get('k-of-n', 1) != 1:",
    "    sys.stderr.write('screensaver right is not an OR rule; refusing to edit'); sys.exit(3)",
    "rule = right.get('rule')",
    "rule = list(rule) if isinstance(rule, list) else ([rule] if isinstance(rule, str) else [])",
    "if name not in rule: rule.append(name)",
    "right['rule'] = rule",
    "with open(sys.argv[3], 'wb') as handle: handle.write(plistlib.dumps(right))",
    "PY",
    `security authorizationdb write ${shellQuote(screensaverRight)} < "$work/right.next.plist"`,
  ].join("\n");
}

/** Removes our name from the screen-saver rule, leaving every other alternative in place. */
function removeRuleAlternativeStep(): string {
  return [
    `security authorizationdb read ${shellQuote(screensaverRight)} > "$work/right.plist" 2>/dev/null || exit 0`,
    `/usr/bin/python3 - ${shellQuote(permitRight)} "$work/right.plist" "$work/right.next.plist" <<'PY'`,
    "import sys, plistlib",
    "name = sys.argv[1]",
    "with open(sys.argv[2], 'rb') as handle: right = plistlib.loads(handle.read())",
    "rule = right.get('rule')",
    "rule = list(rule) if isinstance(rule, list) else ([rule] if isinstance(rule, str) else [])",
    "right['rule'] = [r for r in rule if r != name]",
    "with open(sys.argv[3], 'wb') as handle: handle.write(plistlib.dumps(right))",
    "PY",
    `security authorizationdb write ${shellQuote(screensaverRight)} < "$work/right.next.plist"`,
  ].join("\n");
}

/** The evaluate-mechanisms right that runs our one plug-in mechanism, nothing else. */
export function permitRightPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>class</key><string>evaluate-mechanisms</string>",
    `<key>mechanisms</key><array><string>${xmlEscape(mechanism)}</string></array>`,
    "<key>shared</key><false/>",
    "</dict></plist>",
  ].join("\n");
}

function installDaemonStep(label: string, executable: string): string {
  const plist = shellQuote(daemonPlistPath(label));
  return [
    `cat > ${plist} <<'PLIST'`,
    daemonPlist(label, executable),
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

/** Rejects any artifact path that isn't an absolute, control-character-free POSIX path. */
function validArtifact(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f]/.test(path);
}

/** A runner that refuses both actions when the staged artifacts are unusable. */
const refuseInvalid: PrivilegedRunner = {
  install: () => Promise.reject(new Error("Locked use components are staged at an invalid path.")),
  remove: () => Promise.reject(new Error("Locked use components are staged at an invalid path.")),
};

/**
 * The real privileged runner. `install`/`remove` each assemble one script and run it through a
 * single administrator authorization, then return; the caller (the installer) re-detects and
 * never trusts this result. It fails closed: an invalid artifact path/team or a non-zero script
 * exit rejects, leaving detection to report the true state.
 */
export function privilegedRunner(
  artifacts: LockedUseArtifacts,
  admin: AdminAuthorization,
): PrivilegedRunner {
  const paths = [artifacts.pluginBundle, artifacts.brokerExecutable, artifacts.guardianExecutable];
  if (!paths.every(validArtifact) || !/^[A-Z0-9]{10}$/.test(artifacts.team)) return refuseInvalid;
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
 * Builds the real runner from the artifact paths and team the desktop app stages in the
 * environment, or returns undefined when any is absent — in which case the daemon keeps the
 * pending stub and installing stays unavailable until the components ship and the person
 * approves.
 */
export function privilegedRunnerFromEnv(env: NodeJS.ProcessEnv): PrivilegedRunner | undefined {
  const pluginBundle = env.ACE_LOCKED_USE_PLUGIN?.trim();
  const brokerExecutable = env.ACE_LOCKED_USE_BROKER?.trim();
  const guardianExecutable = env.ACE_LOCKED_USE_GUARDIAN?.trim();
  const team = env.ACE_LOCKED_USE_TEAM?.trim();
  if (!pluginBundle || !brokerExecutable || !guardianExecutable || !team) return undefined;
  return privilegedRunner(
    { pluginBundle, brokerExecutable, guardianExecutable, team },
    osascriptAdmin(),
  );
}
