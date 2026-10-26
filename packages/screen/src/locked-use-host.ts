import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";

/** What one command printed and how it exited. */
export interface MacCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Everything locked-use detection reads from this Mac. Detection only ever asks; nothing here
 * changes the machine. Tests substitute a fake.
 */
export interface MacHost {
  fileExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  exec(command: string, args: readonly string[]): Promise<MacCommandResult>;
  now(): number;
}

export const lockedUseBundlePath =
  "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle";
export const lockedUseBundleId = "dev.ace.locked-use.authorization-plugin";
export const lockedUseMechanism = "AceLockedUseAuthorization:permit";
export const lockedUseRight = "system.login.screensaver";
/** The root broker behind the plug-in's Mach service. */
export const lockedUseBrokerLabel = "dev.ace.locked-use.authorization";
/** The independent relock guardian. */
export const lockedUseGuardianLabel = "dev.ace.locked-use.guardian";

export const codesignPath = "/usr/bin/codesign";
export const securityPath = "/usr/bin/security";
export const launchctlPath = "/bin/launchctl";
export const plutilPath = "/usr/bin/plutil";

/**
 * The only invocations the real host runs: inspection forms of each tool. Anything else is
 * refused before a process starts, so this module can't be turned into a policy writer.
 */
function readOnly(command: string, args: readonly string[]): boolean {
  const [first, second] = args;
  switch (command) {
    case codesignPath:
      return (
        (first === "--verify" && second === "--strict" && args.length === 3) ||
        (first === "-dvv" && args.length === 2)
      );
    case securityPath:
      return first === "authorizationdb" && second === "read" && args.length === 3;
    case launchctlPath:
      return first === "print" && args.length === 2 && /^system\/[\w.-]+$/.test(second ?? "");
    case plutilPath:
      return (
        first === "-extract" &&
        args.length === 6 &&
        args[2] === "raw" &&
        args[3] === "-o" &&
        args[4] === "-"
      );
    default:
      return false;
  }
}

const maxOutput = 256 * 1024;
const maxFile = 256 * 1024;

/** The real macOS host: read-only file checks and the allowlisted inspection commands. */
export function macHost(options: { timeoutMs?: number; now?: () => number } = {}): MacHost {
  const timeout = options.timeoutMs ?? 10_000;
  return {
    async fileExists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path) {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxFile) throw new Error("Unreadable file");
      return readFile(path, "utf8");
    },
    exec(command, args) {
      if (!readOnly(command, args))
        return Promise.reject(new Error(`Refused non-inspection command: ${command}`));
      return new Promise((resolve) => {
        execFile(
          command,
          [...args],
          { timeout, maxBuffer: maxOutput, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
            resolve({ code, stdout, stderr });
          },
        );
      });
    },
    now: options.now ?? (() => performance.now()),
  };
}
