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
    status: () => runtime.refresh(),
    turn: (threadId, agentId) => {
      const thread = ThreadId.safeParse(threadId);
      return thread.success ? services.engine?.activeRun(thread.data, agentId) : undefined;
    },
    agentProcessIDs: async (app) => {
      const pid = await computer.helperProcessId(app);
      return pid === undefined ? [] : [pid];
    },
    runProtected: (scope, agentProcessIDs, work, signal) =>
      runtime.runProtected(scope, agentProcessIDs, work, signal),
  });
}
