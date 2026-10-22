import { realpath } from "node:fs/promises";
import {
  cursorSandboxAttachment,
  cursorSandboxProfile,
  cursorSandboxProfileName,
  type AppArmorProfile,
} from "@ace/browser/linux-sandbox";
import { appArmorRepairHint } from "@ace/browser/engine-check";
import {
  helperLoadProblem,
  hostGlibc,
  sandboxHelperPath,
  sandboxPreflight,
  sandboxUnavailableMessage,
  userNamespacesRestricted,
} from "@ace/adapter-cursor/sandbox-helper";
import type { Check } from "@ace/diagnostics";

type Verdict = Awaited<ReturnType<Check["run"]>>;

/** What the check reads from the machine; tests substitute these. */
export interface CursorSandboxMachine {
  restricted(): boolean;
  /** The helper's resolved path, or undefined when this ace has none. */
  helper(): Promise<string | undefined>;
  preflight(helper: string, signal: AbortSignal): Promise<{ code: number | null; stderr: string }>;
  glibc(): string | undefined;
}

const realMachine: CursorSandboxMachine = {
  restricted: userNamespacesRestricted,
  helper: async () => {
    const path = sandboxHelperPath();
    return path ? realpath(path).catch(() => undefined) : undefined;
  },
  preflight: sandboxPreflight,
  glibc: hostGlibc,
};

export interface CursorSandboxOptions {
  dataDir: string;
  home: string;
  machine?: CursorSandboxMachine;
}

type Finding =
  | { kind: "none"; message: string }
  | { kind: "works" }
  | { kind: "loader"; message: string }
  | { kind: "apparmor"; profile: AppArmorProfile };

async function inspect(options: CursorSandboxOptions, signal: AbortSignal): Promise<Finding> {
  const machine = options.machine ?? realMachine;
  const helper = await machine.helper();
  if (!helper) return { kind: "none", message: "Cursor's sandbox helper isn't part of this ace" };
  const run = await machine.preflight(helper, signal);
  if (run.code === 0) return { kind: "works" };
  const loader = helperLoadProblem(run.stderr, machine.glibc());
  if (loader) return { kind: "loader", message: sandboxUnavailableMessage(loader) };
  return {
    kind: "apparmor",
    profile: {
      name: cursorSandboxProfileName,
      text: cursorSandboxProfile(
        cursorSandboxAttachment({ helper, dataDir: options.dataDir, home: options.home }),
      ),
    },
  };
}

/**
 * The profile `ace doctor --fix` installs for Cursor's helper: only where AppArmor restricts
 * user namespaces and the helper's own preflight fails for that reason.
 */
export async function cursorSandboxRepair(
  options: CursorSandboxOptions,
  signal: AbortSignal,
): Promise<AppArmorProfile | undefined> {
  if (!(options.machine ?? realMachine).restricted()) return undefined;
  const finding = await inspect(options, signal);
  return finding.kind === "apparmor" ? finding.profile : undefined;
}

/**
 * Cursor's sandboxed mode (Auto review) on Ubuntu 23.10+: AppArmor blocks the user namespaces
 * its helper creates until a profile grants them. Only there does the check run the helper's
 * own preflight; elsewhere it says nothing, and the provider reports its own problems.
 */
export function cursorSandboxChecks(options: CursorSandboxOptions): Check[] {
  if (!(options.machine ?? realMachine).restricted()) return [];
  return [
    {
      id: "linux.cursor-sandbox",
      fix: appArmorRepairHint,
      run: async (signal): Promise<Verdict> => {
        const finding = await inspect(options, signal);
        switch (finding.kind) {
          case "none":
            return { status: "ok", message: finding.message, fix: appArmorRepairHint };
          case "works":
            return {
              status: "ok",
              message: "Cursor's sandbox works under AppArmor",
              fix: appArmorRepairHint,
            };
          case "loader":
            return {
              status: "warn",
              message: finding.message,
              fix: "Use Full access for Cursor on this machine.",
            };
          case "apparmor":
            return {
              status: "warn",
              message:
                "Cursor can't run in Auto review: AppArmor restricts the user namespaces its sandbox helper needs (Ubuntu 23.10+). Full access still works.",
              fix: appArmorRepairHint,
            };
        }
      },
    },
  ];
}
