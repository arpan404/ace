import type {
  AutomationPollError,
  AutomationResponse,
  AutomationRun,
  AutomationSource,
  AutomationTriggerError,
  Automation,
} from "@ace/protocol";

/*
 * `automation.list` as entries every client draws, and the daemon's refusals in people's words.
 * Pure: the request lives with each client.
 */

export interface AutomationEntry {
  automation: Automation;
  /** Next scheduled start; undefined when paused, not on a schedule or the service is off. */
  nextRunAt: number | undefined;
  revision: number | undefined;
  lastPollError: AutomationPollError | undefined;
  triggerError: AutomationTriggerError | undefined;
  /** This automation's own latest run, authoritatively from the daemon. */
  lastRun: AutomationRun | undefined;
  /** The thread an agent made it from; undefined for the person's own automations. */
  owner: string | undefined;
}

/** Which store an entry lives in, for the writes that address it. */
export const entrySource = (entry: { owner: string | undefined }): AutomationSource =>
  entry.owner === undefined ? "person" : "thread";

/** The person's automations, and the ones agents made from threads. */
export interface AutomationLists {
  person: AutomationEntry[];
  threads: AutomationEntry[];
}

/** Both stores from one `automation.list` (with `includeThreads`) answer. */
export function automationLists(reply: AutomationResponse): AutomationLists {
  const next = new Map((reply.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  const person = (reply.automations ?? []).map((automation) => {
    const schedule = next.get(automation.id);
    return {
      automation,
      nextRunAt: schedule?.nextRunAt ?? undefined,
      revision: schedule?.revision,
      lastPollError: schedule?.lastPollError,
      triggerError: schedule?.triggerError,
      lastRun: schedule?.lastRun,
      owner: undefined,
    };
  });
  const threads = (reply.threadAutomations ?? []).map((entry) => ({
    automation: entry.automation,
    nextRunAt: entry.nextRunAt ?? undefined,
    revision: entry.revision,
    lastPollError: undefined,
    triggerError: entry.triggerError,
    lastRun: entry.lastRun,
    owner: entry.threadId,
  }));
  return { person, threads };
}

/** A daemon refusal code as what to do about it; unknown messages pass through. */
export function automationErrorMessage(code: string | undefined): string {
  switch (code) {
    case "automation_unavailable":
      return "Automations aren't available on this machine. Restart ace and try again.";
    case "Automation service is stopped":
      return "Automations are turned off. Turn on Run automations in Settings › Agents to run one.";
    case "disabled_or_missing":
      return "That automation is paused or no longer exists.";
    case "Automation is missing":
      return "That automation no longer exists. It may have been deleted on another device.";
    case "Automation already exists":
      return "This automation was recreated elsewhere. Reload to see it, then try again.";
    case "Automation revision conflict":
      return "This automation changed elsewhere. Reload to see the latest, then try again.";
    case "Automation is disabled or missing":
      return "That automation is paused or no longer exists.";
    case "forbidden":
      return "This device isn't allowed to change automations.";
    default:
      return (
        code ?? "Couldn't save or run this automation. Check its project and agent, then try again."
      );
  }
}

/**
 * The automation a lost create made, when its retry is refused with "Automation already exists":
 * the stored one under the id the retry sent, with the same name, task, project and kind of
 * trigger. Undefined when that id holds something else.
 */
export function savedBefore(
  stored: readonly Automation[],
  sent: Automation,
): Automation | undefined {
  return stored.find(
    (entry) =>
      entry.id === sent.id &&
      entry.title === sent.title &&
      entry.prompt === sent.prompt &&
      entry.workspace === sent.workspace &&
      entry.trigger.kind === sent.trigger.kind,
  );
}
