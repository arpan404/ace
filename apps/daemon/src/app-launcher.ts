import { execFile } from "node:child_process";
import { readlinkSync, statSync } from "node:fs";
import { posix } from "node:path";

/*
 * Whether the process that started this daemon is the signed ace desktop app (ADR 0178 §12.8),
 * so the key it wrote on stdin may give its page the person's standing. Any launcher can set
 * `ACE_APP_KEY=stdin` and write a key; only the app's counts. Checked once, as the key is read.
 */

/** Set only by a development build's bundler (`define`); never by the environment. */
declare const ACE_DEVELOPMENT_TRUST: boolean | undefined;

/**
 * A development build trusts any launcher's key: an unsigned app in a checkout has no identity
 * to check. Source runs and release bundles leave the constant undefined.
 */
export const developmentTrust =
  typeof ACE_DEVELOPMENT_TRUST !== "undefined" && ACE_DEVELOPMENT_TRUST === true;

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
  /** The deb's install (`/opt/ace/ace-desktop`), or a distribution's under /usr. */
  linuxNames: ["ace-desktop"] as readonly string[],
  linuxRoots: ["/opt/", "/usr/"] as readonly string[],
};

/** What a Linux launcher check reads of one path. */
export interface PathOwner {
  readonly uid: number;
  readonly mode: number;
}

/**
 * Whether `exe` (the launcher's `/proc/<pid>/exe`) is the installed app: named as the app, under
 * a root-owned prefix, and the file and every directory above it owned by root and writable by
 * no one else, so no process of the person's could have put it there or changed it. Pure.
 */
export function linuxAppLauncher(
  exe: string | undefined,
  owner: (path: string) => PathOwner | undefined,
): boolean {
  if (!exe || !posix.isAbsolute(exe) || posix.normalize(exe) !== exe) return false;
  if (!appLauncherIdentity.linuxNames.includes(posix.basename(exe))) return false;
  if (!appLauncherIdentity.linuxRoots.some((root) => exe.startsWith(root))) return false;
  for (let path = exe; ; path = posix.dirname(path)) {
    const facts = owner(path);
    if (!facts || facts.uid !== 0 || (facts.mode & 0o022) !== 0) return false;
    if (path === "/") return true;
  }
}

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

/**
 * The check for this platform: macOS asks the Security framework, through Apple's `codesign`, to
 * validate the running process `pid` against the app's designated requirement; Windows checks
 * the Authenticode signer of the process's executable; Linux checks where the executable lives.
 */
export async function launcherIsApp(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (developmentTrust) return true;
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (platform === "darwin")
    return (
      (await tool("/usr/bin/codesign", [
        "--verify",
        `-R=${appLauncherIdentity.macRequirement}`,
        String(pid),
      ])) !== undefined
    );
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
  if (platform === "linux") {
    let exe: string | undefined;
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return false;
    }
    return linuxAppLauncher(exe, (path) => {
      try {
        const facts = statSync(path);
        return { uid: facts.uid, mode: facts.mode };
      } catch {
        return undefined;
      }
    });
  }
  return false;
}
