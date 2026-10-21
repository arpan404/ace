import { libraryInstallCommand, missingLibraries, type LinuxFamily } from "./linux-libraries.ts";

/** Why Chrome would not start, when the cause is one a person can fix on this machine. */
export type ChromeLaunchProblem =
  | { kind: "missing_libraries"; libraries: string[]; install?: string }
  | { kind: "sandbox_blocked"; cause: "apparmor" | "userns_disabled" | "unknown" }
  | { kind: "running_as_root" }
  | { kind: "unknown" };

/** What the I/O shell found out about the machine after a failed start. */
export interface ChromeLaunchFacts {
  /** The end of Chrome's stderr. */
  stderr: string;
  /** `ldd` output for the executable, when it was run. */
  ldd?: string;
  family?: LinuxFamily;
  /** `kernel.apparmor_restrict_unprivileged_userns` is 1. */
  appArmorRestrictsUserns?: boolean;
  /** `kernel.unprivileged_userns_clone` is 0 (Debian's older switch). */
  usernsCloneDisabled?: boolean;
  root?: boolean;
}

export function classifyChromeLaunch(facts: ChromeLaunchFacts): ChromeLaunchProblem {
  const libraries = missingLibraries(`${facts.stderr}\n${facts.ldd ?? ""}`);
  if (libraries.length) {
    const install = libraryInstallCommand(libraries, facts.family);
    return { kind: "missing_libraries", libraries, ...(install ? { install } : {}) };
  }
  if (/Running as root without --no-sandbox is not supported/.test(facts.stderr))
    return { kind: "running_as_root" };
  if (/No usable sandbox/.test(facts.stderr))
    return {
      kind: "sandbox_blocked",
      cause: facts.appArmorRestrictsUserns
        ? "apparmor"
        : facts.usernsCloneDisabled
          ? "userns_disabled"
          : "unknown",
    };
  return { kind: "unknown" };
}

const noSandbox = "or set ACE_CHROMIUM_NO_SANDBOX=1 for ace's daemon to run it without the sandbox";
/**
 * The person's next step, short enough for an agent's error detail (256 characters): the agent
 * relays it. `ace doctor` gives the full fix, such as the AppArmor profile text.
 */
export function launchProblemDetail(problem: ChromeLaunchProblem): string | undefined {
  switch (problem.kind) {
    case "missing_libraries": {
      const install = problem.install ? `Run: ${problem.install}` : "Install them";
      const names = problem.libraries.join(", ");
      const text = `Missing ${names}. ${install}`;
      return text.length <= 256 ? text : `${install}`.slice(0, 256);
    }
    case "sandbox_blocked":
      return problem.cause === "apparmor"
        ? `AppArmor blocks Chrome's sandbox (Ubuntu 23.10+). Install ace's AppArmor profile once (ace doctor prints it), ${noSandbox}.`
        : problem.cause === "userns_disabled"
          ? `This kernel disables the user namespaces Chrome's sandbox needs: sudo sysctl -w kernel.unprivileged_userns_clone=1, ${noSandbox}.`
          : `Chrome's sandbox could not start; ace doctor shows why, ${noSandbox}.`;
    case "running_as_root":
      return `ace's daemon runs as root, where Chrome refuses its sandbox. Run ace as a normal user, ${noSandbox}.`;
    case "unknown":
      return undefined;
  }
}

/** A failed start of ace's Chrome. Its message keeps Chrome's own words for the daemon log. */
export class ChromeLaunchError extends Error {
  readonly problem: ChromeLaunchProblem;
  constructor(message: string, problem: ChromeLaunchProblem, options?: ErrorOptions) {
    super(
      message.startsWith("Chrome failed to start") ? message : `Chrome failed to start: ${message}`,
      options,
    );
    this.name = "ChromeLaunchError";
    this.problem = problem;
  }
}
