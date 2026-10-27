import { ThreadId } from "@ace/protocol";
import type { Toolkit } from "@ace/mcp-server";
import {
  computerToolkit,
  type ComputerClient,
  type ComputerMachineRoute,
  type ComputerPlatform,
} from "@ace/screen";
import { computerLockedUseGate } from "./computer-locked-use.ts";
import type { Services } from "./services/types.ts";

/** The computer-use tools' wording for the daemon's platform. */
export function computerPlatform(platform: NodeJS.Platform): ComputerPlatform {
  if (platform === "win32") return "windows";
  return platform === "linux" ? "linux" : "macos";
}

/**
 * This daemon's computer-use tools (screen_apps, screen_state, screen_act) with its own rules:
 * the person's blocked apps, the task list's "using apps" mark and Locked Use. Agents here and
 * agents from linked machines (ADR 0105) get the same toolkit, so the same rules apply to both.
 */
export function daemonComputerToolkit(
  services: Pick<
    Partial<Services>,
    "computerUsing" | "settings" | "lockedUseRuntime" | "computer" | "engine"
  >,
  computer: ComputerClient,
  route?: ComputerMachineRoute,
): Toolkit {
  const lockedUse = computerLockedUseGate(services);
  return computerToolkit(computer, {
    platform: computerPlatform(process.platform),
    // Read on every call, so a change in Settings applies to the next one.
    blockedApps: async () => (await services.settings?.get("computer.blockedApps"))?.value ?? [],
    using: (threadId, app) =>
      services.computerUsing?.begin(ThreadId.parse(threadId), app) ?? (() => {}),
    ...(lockedUse ? { lockedUse } : {}),
    ...(route ? { route } : {}),
  });
}
