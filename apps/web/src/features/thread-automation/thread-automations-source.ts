import type { ClientApi } from "@ace/client";
import type { Automation, AutomationRun, AutomationTriggerError } from "@ace/protocol";

/*
 * The automations agents made from threads: `automation.list` with `includeThreads`, and the
 * Pause/Resume write, addressed to the thread store (`source: "thread"`). A refusal rejects
 * with the daemon's reason.
 */

export interface ThreadAutomation {
  automation: Automation;
  /** The thread that owns it; its runs are delegated under this thread. */
  threadId: string;
  /** Next scheduled start; undefined when paused, not on a schedule or not placed yet. */
  nextRunAt: number | undefined;
  revision: number | undefined;
  triggerError: AutomationTriggerError | undefined;
  lastRun: AutomationRun | undefined;
}

export async function listThreadAutomations(
  client: ClientApi,
  signal: AbortSignal,
): Promise<ThreadAutomation[]> {
  const reply = await client.request({ type: "automation.list", includeThreads: true }, { signal });
  if (!reply.ok) throw new Error(reply.error ?? "Couldn't read automations.");
  return (reply.threadAutomations ?? []).map((entry) => ({
    automation: entry.automation,
    threadId: entry.threadId,
    nextRunAt: entry.nextRunAt ?? undefined,
    revision: entry.revision,
    triggerError: entry.triggerError,
    lastRun: entry.lastRun,
  }));
}

export async function setThreadAutomationEnabled(
  client: ClientApi,
  id: string,
  enabled: boolean,
  revision: number | undefined,
): Promise<void> {
  const reply = await client.request({
    type: "automation.setEnabled",
    id,
    enabled,
    source: "thread",
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  });
  if (!reply.ok) throw new Error(reply.error ?? "Couldn't change the automation.");
}
