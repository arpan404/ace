/*
 * The computer tools' locked use gate, wired to this daemon: the person's
 * `computer.lockedUse` setting, the locked use service, the engine's active run for the
 * calling agent (the approved turn) and the computer helper that will do the work.
 */
import { ThreadId } from "@ace/protocol";
import { lockedUseGate, type LockedUseGate } from "@ace/screen";
import type { Services } from "./services/types.ts";

export function computerLockedUseGate(
  services: Pick<Partial<Services>, "lockedUseRuntime" | "computer" | "settings" | "engine">,
): LockedUseGate | undefined {
  const runtime = services.lockedUseRuntime;
  const computer = services.computer;
  if (!runtime || !computer) return undefined;
  return lockedUseGate({
    // Read on every call, so turning it off applies to the next one.
    enabled: async () => (await services.settings?.get("computer.lockedUse"))?.value === true,
    intervalActive: () => runtime.intervalActive(),
    status: () => runtime.refresh(),
    turn: (threadId, agentId) => {
      const thread = ThreadId.safeParse(threadId);
      return thread.success ? services.engine?.activeRun(thread.data, agentId) : undefined;
    },
    agentProcessIDs: async (app) => {
      const pid = await computer.helperProcessId(app);
      return pid === undefined ? [] : [pid];
    },
    runProtected: (scope, agentProcessIDs, work, signal, optIn) =>
      runtime.runProtected(scope, agentProcessIDs, work, signal, optIn),
  });
}

/**
 * Turning `computer.lockedUse` off stops any queued or running protected attempt; each relocks
 * the Mac and reports itself cancelled. Resolves to the subscription's release.
 */
export async function cancelLockedUseWhenTurnedOff(
  services: Pick<Partial<Services>, "lockedUseRuntime" | "settings">,
): Promise<(() => void) | undefined> {
  const runtime = services.lockedUseRuntime;
  const settings = services.settings;
  if (!runtime || !settings) return undefined;
  // Without the subscription the gate still reads the setting on every call.
  return settings
    .subscribe({ keys: ["computer.lockedUse"], scope: {} }, (notification) => {
      if (notification.type !== "changed") return;
      const entry = notification.entries.find((each) => each.key === "computer.lockedUse");
      if (entry && entry.value !== true) runtime.cancelActive();
    })
    .catch(() => undefined);
}
