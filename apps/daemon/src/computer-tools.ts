import { ThreadId } from "@ace/protocol";
import type { Toolkit } from "@ace/mcp-server";
import {
  computerToolkit,
  screenTargetApps,
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
    | "computerUsing"
    | "settings"
    | "lockedUseRuntime"
    | "computer"
    | "engine"
    | "screen"
    | "screenCowork"
  >,
  computer: ComputerClient | undefined,
  route?: ComputerMachineRoute,
  /**
   * Who is told a caller is using an app. Default: the task list's mark for the caller's thread;
   * outside clients (ADR 0122) have their own line instead.
   */
  using?: (threadId: string, app: string, appId?: string) => () => void,
): Toolkit {
  const lockedUse = computerLockedUseGate(services);
  return computerToolkit(computer, {
    platform: computerPlatform(process.platform),
    enabled: () => services.screen?.isEnabled() ?? false,
    // Read on every call, so a change in Settings applies to the next one.
    blockedApps: async () => (await services.settings?.get("computer.blockedApps"))?.value ?? [],
    personExclusive: (appId) =>
      services.screen
        ?.states()
        .some(
          (state) => state.controller === "human" && screenTargetApps(state.target).includes(appId),
        ) ?? false,
    using:
      using ??
      ((threadId, app, appId) =>
        services.computerUsing?.begin(ThreadId.parse(threadId), app, appId) ?? (() => {})),
    ...(lockedUse ? { lockedUse } : {}),
    ...(route ? { route } : {}),
    ...(services.screenCowork ? { cowork: services.screenCowork } : {}),
  });
}
