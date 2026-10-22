import type { AutomationService } from "@ace/automations";
import type { AutomationRequest, AutomationResponse, ThreadId } from "@ace/protocol";

type ThreadAutomation = NonNullable<AutomationResponse["threadAutomations"]>[number];
/** Requests that address one store, as `source: "thread"` sends them. */
export type ThreadAutomationRequest = Extract<
  AutomationRequest,
  { type: "automation.remove" | "automation.run" | "automation.inbox" | "automation.setEnabled" }
>;

/**
 * The person's view of automations agents made from threads: each listed with its owner thread,
 * and the same pause, run, delete and history controls as their own. Agents' MCP calls go
 * through the owner checks in `owners.ts` instead.
 */
export interface ThreadAutomations {
  list(): ThreadAutomation[];
  handle(request: ThreadAutomationRequest): AutomationResponse;
}

const refuse = (requestId: string, error: string): AutomationResponse => ({
  type: "automation.result",
  requestId,
  ok: false,
  error,
});

export function createThreadAutomations(
  automations: AutomationService,
  /** The live thread that owns an automation; undefined once that thread is gone. */
  ownerThread: (automationId: string) => ThreadId | undefined,
): ThreadAutomations {
  return {
    list() {
      const listed = automations.handle({ type: "automation.list", requestId: "thread-list" });
      const schedules = new Map((listed.schedules ?? []).map((entry) => [entry.id, entry]));
      return (listed.automations ?? []).flatMap((automation) => {
        const threadId = ownerThread(automation.id);
        if (!threadId) return [];
        const schedule = schedules.get(automation.id);
        return [
          {
            automation,
            threadId,
            nextRunAt: schedule?.nextRunAt ?? null,
            ...(schedule?.revision ? { revision: schedule.revision } : {}),
            ...(schedule?.triggerError ? { triggerError: schedule.triggerError } : {}),
            ...(schedule?.lastRun ? { lastRun: schedule.lastRun } : {}),
          },
        ];
      });
    },
    handle(request) {
      const id = request.type === "automation.inbox" ? request.automationId : request.id;
      if (id !== undefined && !ownerThread(id)) return refuse(request.requestId, "not_found");
      const result = automations.handle(request);
      // History across every thread leaves out runs whose thread is gone, as the list does.
      if (!result.inbox) return result;
      return {
        ...result,
        inbox: {
          ...result.inbox,
          runs: result.inbox.runs.filter((run) => ownerThread(run.automationId)),
        },
      };
    },
  };
}
