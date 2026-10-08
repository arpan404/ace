/*
 * Automations from the daemon (ADR 0015): `automation.list` (definitions and their next
 * scheduled start), `automation.inbox` (recent runs), and the `automation.put`, `remove` and
 * `run` writes. Each is a correlated request; a refusal rejects with the daemon's reason.
 */
import type { ClientApi } from "@ace/client";
import { Automation, type AutomationResponse, type AutomationRun } from "@ace/protocol";

export interface AutomationEntry {
  automation: Automation;
  /** Next scheduled start; undefined when paused, not on a schedule or the service is off. */
  nextRunAt: number | undefined;
}

export class AutomationError extends Error {
  constructor(code: string | undefined) {
    super(automationErrorMessage(code));
    this.name = "AutomationError";
  }
}

function automationErrorMessage(code: string | undefined): string {
  switch (code) {
    case "automation_unavailable":
      return "ace on this machine's automation service isn't running.";
    case "Automation service is stopped":
      return "Automations are turned off. Turn on Run automations in Settings › General to run one.";
    case "disabled_or_missing":
      return "That automation is paused or no longer exists.";
    case "forbidden":
      return "This device isn't allowed to change automations.";
    default:
      return code ? `ace refused that (${code}).` : "ace refused that.";
  }
}

function checked(reply: AutomationResponse): AutomationResponse {
  if (!reply.ok) throw new AutomationError(reply.error);
  return reply;
}

export async function listAutomations(
  client: ClientApi,
  signal: AbortSignal,
): Promise<AutomationEntry[]> {
  const reply = checked(await client.request({ type: "automation.list" }, { signal }));
  const next = new Map(reply.schedules?.map((schedule) => [schedule.id, schedule.nextRunAt]));
  return (reply.automations ?? []).map((automation) => ({
    automation,
    nextRunAt: next.get(automation.id) ?? undefined,
  }));
}

/** Recent runs across every automation, newest first. */
export async function automationInbox(
  client: ClientApi,
  limit: number,
  signal: AbortSignal,
): Promise<AutomationRun[]> {
  const reply = checked(await client.request({ type: "automation.inbox", limit }, { signal }));
  return (reply.inbox?.runs ?? []).toSorted((a, b) => b.startedAt - a.startedAt);
}

/** Create or replace. Rejects definitions the protocol schema refuses before sending. */
export async function putAutomation(client: ClientApi, automation: Automation): Promise<void> {
  checked(
    await client.request({ type: "automation.put", automation: Automation.parse(automation) }),
  );
}

export async function removeAutomation(client: ClientApi, id: string): Promise<void> {
  checked(await client.request({ type: "automation.remove", id }));
}

/** Start a run now, whatever the trigger. Resolves with the run as the daemon admitted it. */
export async function runAutomation(client: ClientApi, id: string): Promise<AutomationRun> {
  const reply = checked(await client.request({ type: "automation.run", id, variables: {} }));
  if (!reply.run) throw new AutomationError(undefined);
  return reply.run;
}
