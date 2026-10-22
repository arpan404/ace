import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ChromeStartFailure } from "./chrome-instance.ts";
import {
  ChromeLaunchError,
  classifyChromeLaunch,
  launchProblemDetail,
  type ChromeLaunchFacts,
  type SandboxFacts,
} from "./launch-failure.ts";
import { linuxFamily } from "./linux-libraries.ts";

/** The machine, as a failed start or `ace doctor` sees it. Injected so tests can stand in. */
export interface LinuxMachine {
  readText(path: string): Promise<string | undefined>;
  /** `ldd` output for an executable; undefined when it could not run. */
  ldd(executable: string): Promise<string | undefined>;
  root: boolean;
}
export const linuxMachine: LinuxMachine = {
  readText: (path) => readFile(path, "utf8").catch(() => undefined),
  ldd: (executable) =>
    new Promise((resolve) => {
      execFile("ldd", [executable], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (_error, stdout) =>
        resolve(stdout || undefined),
      );
    }),
  root: process.getuid?.() === 0,
};

/**
 * The kernel switches Chrome's sandbox depends on. A switch the kernel does not have (no
 * AppArmor, as on Arch; no Debian clone patch) is absent, which never blocks the sandbox.
 */
export async function sandboxFacts(machine: LinuxMachine): Promise<SandboxFacts> {
  const flag = async (path: string) => (await machine.readText(path))?.trim();
  const [apparmor, clone] = await Promise.all([
    flag("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    flag("/proc/sys/kernel/unprivileged_userns_clone"),
  ]);
  return { appArmorRestrictsUserns: apparmor === "1", usernsCloneDisabled: clone === "0" };
}

/** What a failed start of `executable` with `stderr` says about this machine. */
export async function chromeLaunchFacts(
  executable: string,
  stderr: string,
  machine: LinuxMachine,
): Promise<ChromeLaunchFacts> {
  const [osRelease, sandbox, ldd] = await Promise.all([
    machine.readText("/etc/os-release"),
    sandboxFacts(machine),
    // Only a loader failure needs the full list of what is missing.
    /error while loading shared libraries/.test(stderr) ? machine.ldd(executable) : undefined,
  ]);
  const family = osRelease === undefined ? undefined : linuxFamily(osRelease);
  return {
    stderr,
    ...(ldd === undefined ? {} : { ldd }),
    ...(family ? { family } : {}),
    ...sandbox,
    root: machine.root,
  };
}

/** `ChromeLaunch.diagnose` for Linux: keeps Chrome's words and adds the person's next step. */
export function linuxLaunchDiagnosis(machine: LinuxMachine = linuxMachine) {
  return async (failure: ChromeStartFailure): Promise<Error> => {
    const problem = classifyChromeLaunch(
      await chromeLaunchFacts(failure.executable, failure.stderr, machine),
    );
    if (problem.kind === "unknown") return failure.error;
    const detail = launchProblemDetail(problem);
    return new ChromeLaunchError(
      `${failure.error.message}${detail ? `. ${detail}` : ""}`,
      problem,
      { cause: failure.error },
    );
  };
}

/**
 * Chrome keeps shared memory in `/dev/shm`; containers often give it 64 MB, where tabs crash.
 * Below 512 MB Chrome is told to use the temp directory instead.
 */
export function smallSharedMemory(
  stat: (path: string) => { blocks: number; bsize: number } = statfsSync,
): boolean {
  try {
    const fs = stat("/dev/shm");
    return fs.blocks * fs.bsize < 512 * 1024 * 1024;
  } catch {
    return true;
  }
}
