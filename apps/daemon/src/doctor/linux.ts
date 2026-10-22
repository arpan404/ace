import { spawn } from "node:child_process";
import { browserEngineRepairs, type EngineRepairs } from "@ace/browser/engine-check";
import {
  appArmorInstallCommands,
  appArmorSetupArgs,
  type AppArmorProfile,
} from "@ace/browser/linux-sandbox";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import { cursorSandboxRepair } from "../cursor-sandbox-check.ts";
import type { PlannedRepair } from "../doctor-plan.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";

export const PACKAGES_REPAIR = "linux.packages";
export const APPARMOR_REPAIR = "linux.apparmor";

/** What this machine needs so ace's browser and Cursor's sandbox start. */
export type LinuxNeeds = {
  packages?: { libraries: string[]; steps: string[][] };
  profiles: AppArmorProfile[];
};

export type LinuxFeatureOptions = {
  /** Reads the machine, not the report: report text is redacted and can't be run. */
  needs?(report: DiagnosticReport, context: DoctorContext): Promise<LinuxNeeds>;
  /** Runs one command as root on the person's terminal; resolves its exit code. */
  runAsRoot?(argv: string[]): Promise<number | null>;
  /** Already root: commands run without sudo. */
  root?: boolean;
};

/**
 * Linux host repairs: the system libraries ace's Chrome can't load, and the AppArmor profiles
 * that let its sandbox and Cursor's create user namespaces on Ubuntu 23.10+. The checks are base
 * checks (`chromium`, `linux.cursor-sandbox`), so the app shows them too; only the CLI repairs.
 * Both repairs need root, and sudo asks for the person's password before anything changes.
 */
export function createLinuxFeature(options: LinuxFeatureOptions = {}): DoctorFeature {
  const needs = options.needs ?? machineNeeds;
  const root = options.root ?? process.getuid?.() === 0;
  const run = options.runAsRoot ?? ((argv) => runOnTerminal(root ? argv : ["sudo", ...argv]));
  const shown = (argv: string[]) => (root ? "" : "sudo ") + argv.join(" ");
  return {
    id: "linux",
    checks: () => [],
    async repairs(report, context) {
      if (context.platform !== "linux") return [];
      const found = await needs(report, context);
      const plan: PlannedRepair[] = [];
      if (found.packages)
        plan.push({
          id: PACKAGES_REPAIR,
          title: "Install the libraries ace's browser needs",
          detail: `Installs the packages for ${found.packages.libraries.join(", ")}. Runs:\n${found.packages.steps.map(shown).join("\n")}`,
          recommended: true,
        });
      if (found.profiles.length)
        plan.push({
          id: APPARMOR_REPAIR,
          title: `Install ace's AppArmor ${found.profiles.length === 1 ? "profile" : "profiles"} (${found.profiles.map((profile) => profile.name).join(", ")})`,
          detail: `Lets these sandboxes create user namespaces; AppArmor checks each profile before it is written. Same as running:\n${appArmorInstallCommands(found.profiles)}`,
          recommended: true,
        });
      return plan;
    },
    async apply(repairId, report, context) {
      const found = await needs(report, context);
      if (repairId === PACKAGES_REPAIR) {
        if (!found.packages)
          return [skipped(repairId, "ace's browser no longer misses any libraries.")];
        for (const step of found.packages.steps) {
          const code = await run(step);
          if (code !== 0)
            return [failed(repairId, `${shown(step)} exited with ${code ?? "a signal"}.`)];
        }
        return [
          fixed(repairId, `Installed the packages for ${found.packages.libraries.join(", ")}.`),
        ];
      }
      if (repairId === APPARMOR_REPAIR) {
        if (!found.profiles.length)
          return [skipped(repairId, "ace's AppArmor profiles are already installed.")];
        const names = found.profiles.map((profile) => profile.name).join(", ");
        const code = await run(appArmorSetupArgs(found.profiles));
        if (code === 0) return [fixed(repairId, `Installed and loaded ${names}.`)];
        return [
          failed(
            repairId,
            code === 64 || code === 65
              ? `AppArmor refused ${names}; nothing was written.`
              : `${names} not installed (exit ${code ?? "by a signal"}). ace doctor --dry-run prints the commands to run yourself.`,
          ),
        ];
      }
      return [skipped(repairId, "Not a Linux repair.")];
    },
  };
}

async function machineNeeds(report: DiagnosticReport, context: DoctorContext): Promise<LinuxNeeds> {
  const open = (id: string) =>
    report.checks.some((check) => check.id === id && check.status !== "ok");
  const signal = AbortSignal.timeout(25_000);
  const { dataDir } = context.config;
  const none: EngineRepairs = {};
  const [browser, cursor] = await Promise.all([
    open("chromium")
      ? browserEngineRepairs({ dataDir, env: context.env, home: context.home, signal })
      : none,
    open("linux.cursor-sandbox")
      ? cursorSandboxRepair({ dataDir, home: context.home }, signal)
      : undefined,
  ]);
  return {
    ...(browser.packages
      ? { packages: { libraries: browser.packages.libraries, steps: browser.packages.steps } }
      : {}),
    profiles: [browser.profile, cursor].filter((profile) => profile !== undefined),
  };
}

/** Runs on the person's terminal so sudo and the package manager can ask and show progress. */
function runOnTerminal(argv: string[]): Promise<number | null> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    // Not installed (no sudo in a minimal system): the shell's "command not found".
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code));
  });
}

const fixed = (id: string, message: string): DiagnosticRepair => ({ id, status: "fixed", message });
const failed = (id: string, message: string): DiagnosticRepair => ({
  id,
  status: "failed",
  message,
});
const skipped = (id: string, message: string): DiagnosticRepair => ({
  id,
  status: "skipped",
  message,
});

export const linux: DoctorFeature = createLinuxFeature();
