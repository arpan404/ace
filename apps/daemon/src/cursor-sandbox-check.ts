import { realpath } from "node:fs/promises";
import {
  appArmorInstallCommands,
  cursorSandboxAttachment,
  cursorSandboxProfile,
  cursorSandboxProfileName,
} from "@ace/browser/linux-sandbox";
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

const fixHint = "Install the ace-cursor-sandbox AppArmor profile `ace doctor` prints.";

/**
 * Cursor's sandboxed mode (Auto review) on Ubuntu 23.10+: AppArmor blocks the user namespaces
 * its helper creates until a profile grants them. Only there does the check run the helper's
 * own preflight; elsewhere it says nothing, and the provider reports its own problems.
 */
export function cursorSandboxChecks(options: {
  dataDir: string;
  home: string;
  machine?: CursorSandboxMachine;
}): Check[] {
  const machine = options.machine ?? realMachine;
  if (!machine.restricted()) return [];
  return [
    {
      id: "linux.cursor-sandbox",
      fix: fixHint,
      run: async (signal): Promise<Verdict> => {
        const helper = await machine.helper();
        if (!helper)
          return {
            status: "ok",
            message: "Cursor's sandbox helper isn't part of this ace",
            fix: fixHint,
          };
        const run = await machine.preflight(helper, signal);
        if (run.code === 0)
          return { status: "ok", message: "Cursor's sandbox works under AppArmor", fix: fixHint };
        const loader = helperLoadProblem(run.stderr, machine.glibc());
        if (loader)
          return {
            status: "warn",
            message: sandboxUnavailableMessage(loader),
            fix: "Use Full access for Cursor on this machine.",
          };
        const commands = appArmorInstallCommands([
          {
            name: cursorSandboxProfileName,
            text: cursorSandboxProfile(
              cursorSandboxAttachment({ helper, dataDir: options.dataDir, home: options.home }),
            ),
          },
        ]);
        return {
          status: "warn",
          message:
            "Cursor can't run in Auto review: AppArmor restricts the user namespaces its sandbox helper needs (Ubuntu 23.10+). Full access still works.",
          fix: `Install ace's AppArmor profile for it once:\n${commands}`,
        };
      },
    },
  ];
}
