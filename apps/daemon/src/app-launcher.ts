import { execFile } from "node:child_process";

/*
 * Whether the process that started this daemon is the signed ace desktop app (ADR 0178 §12.8),
 * so the key it wrote on stdin may give its page the person's standing. Any launcher can set
 * `ACE_APP_KEY=stdin` and write a key; only the app's counts. Checked once, as the key is read.
 */

/** Set only by a development build's bundler (`define`); never by the environment. */
declare const ACE_DEVELOPMENT_TRUST: boolean | undefined;
/**
 * Set only by a build that ships the daemon's code (its bundle, chunks, workers and native
 * addons, and the runtime that runs them) inside the app's sealed, integrity-checked archive.
 * None does yet: the daemon runs from files beside the archive that a process of the person's
 * can change, so a signed app launching it proves nothing about the code that reads the key.
 */
declare const ACE_DAEMON_CODE_SEALED: boolean | undefined;

/**
 * A development build trusts any launcher's key: an unsigned app in a checkout has no identity
 * to check. Source runs and release bundles leave the constant undefined.
 */
export const developmentTrust =
  typeof ACE_DEVELOPMENT_TRUST !== "undefined" && ACE_DEVELOPMENT_TRUST === true;
export const daemonCodeSealed =
  typeof ACE_DAEMON_CODE_SEALED !== "undefined" && ACE_DAEMON_CODE_SEALED === true;

/** The signed app's identity, per platform. */
export const appLauncherIdentity = {
  /** The app's bundle id and its Developer ID team, as `package.ts` signs it. */
  macRequirement:
    'anchor apple generic and identifier "dev.ace.app" and certificate leaf[subject.OU] = "5J88TLUP2J"',
  /**
   * The Authenticode signer's subject a Windows release is signed with. None yet: Windows builds
   * ship unsigned until a certificate exists, and until it is pinned here no launcher counts.
   */
  windowsPublisher: undefined as string | undefined,
};

/**
 * Whether PowerShell's `Get-AuthenticodeSignature` answer (`Status`, then the signer's subject,
 * one per line) names a valid signature by `publisher`. Pure.
 */
export function windowsAppLauncher(answer: string, publisher: string | undefined): boolean {
  if (!publisher) return false;
  const [status, subject] = answer.split(/\r?\n/);
  return status?.trim() === "Valid" && subject?.trim() === publisher;
}

/** Run a system tool with an empty environment, answering its stdout, or undefined on failure. */
function tool(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: 10_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : String(stdout)),
    );
  });
}

/** What a launcher check may need beyond the pid; tests substitute them. */
export interface LauncherChecks {
  /** The daemon's own code ships sealed with the app (`ACE_DAEMON_CODE_SEALED`). */
  readonly sealed: boolean;
  /** macOS: the running process `pid` satisfies the app's designated requirement. */
  codesign(pid: number): Promise<boolean>;
}

const systemChecks: LauncherChecks = {
  sealed: daemonCodeSealed,
  codesign: async (pid) =>
    (await tool("/usr/bin/codesign", [
      "--verify",
      `-R=${appLauncherIdentity.macRequirement}`,
      String(pid),
    ])) !== undefined,
};

/**
 * The check for this platform (ADR 0178 §12.8):
 * - macOS: the daemon's code must ship sealed with the app, and the Security framework, through
 *   Apple's `codesign`, must validate the running parent against the app's designated
 *   requirement. No build seals the daemon's code yet, so no launcher counts.
 * - Windows: the Authenticode signer of the parent's executable must be the pinned publisher.
 *   None is pinned yet, so no launcher counts.
 * - Linux and anything else: never. Any process of the person's can start the genuine app with
 *   `LD_PRELOAD` and read the key it writes; that needs a launch-integrity boundary first.
 */
export async function launcherIsApp(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  checks: LauncherChecks = systemChecks,
): Promise<boolean> {
  if (developmentTrust) return true;
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (platform === "darwin") return checks.sealed && (await checks.codesign(pid));
  if (platform === "win32") {
    const publisher = appLauncherIdentity.windowsPublisher;
    if (!publisher) return false;
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const script = `$p=(Get-Process -Id ${pid}).Path; $s=Get-AuthenticodeSignature -FilePath $p; $s.Status; $s.SignerCertificate.Subject`;
    const answer = await tool(
      `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      // Nothing from the launcher's environment, so it can't put its own modules on the path.
      { SystemRoot: root },
    );
    return answer !== undefined && windowsAppLauncher(answer, publisher);
  }
  return false;
}
