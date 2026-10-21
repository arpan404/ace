/*
 * Automations from the daemon (ADR 0015): `automation.list` (definitions and their next
 * scheduled start), `automation.inbox` (recent runs), and the `automation.put`,
 * `remove`, `setEnabled`, `retry` and `run` writes. Each is a correlated request; a
 * refusal rejects with the daemon's reason. Writes carry the entry's revision as a
 * compare-and-swap: omitted for backward compatibility, null for create-only, and a
 * number for stale-edit protection.
 */
import type { ClientApi } from "@ace/client";
import {
  Automation,
  type AutomationSource,
  type AutomationResponse,
  type AutomationRun,
  type AutomationInbox,
  type AutomationPollError,
  type AutomationTriggerError,
} from "@ace/protocol";

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

export class AutomationError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super(automationErrorMessage(code));
    this.name = "AutomationError";
    this.code = code;
  }
}

function automationErrorMessage(code: string | undefined): string {
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

function checked(reply: AutomationResponse): AutomationResponse {
  if (!reply.ok) throw new AutomationError(reply.error);
  return reply;
}

export async function listAutomations(
  client: ClientApi,
  signal: AbortSignal,
): Promise<AutomationLists> {
  const reply = checked(
    await client.request({ type: "automation.list", includeThreads: true }, { signal }),
  );
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

/** Recent runs across every automation, newest first. */
export async function automationInbox(
  client: ClientApi,
  limit: number,
  signal: AbortSignal,
): Promise<AutomationRun[]> {
  const reply = checked(await client.request({ type: "automation.inbox", limit }, { signal }));
  return (reply.inbox?.runs ?? []).toSorted((a, b) => b.startedAt - a.startedAt);
}

/** One bounded history page, filtered before paging so busy automations cannot hide it. */
export async function automationHistory(
  client: ClientApi,
  automationId: string,
  source: AutomationSource,
  before: number | undefined,
  signal: AbortSignal,
): Promise<AutomationInbox> {
  const reply = checked(
    await client.request(
      {
        type: "automation.inbox",
        automationId,
        limit: 50,
        ...(source === "thread" ? { source } : {}),
        ...(before === undefined ? {} : { before }),
      },
      { signal },
    ),
  );
  return reply.inbox ?? { runs: [], before: null };
}

/**
 * Create or replace. Null is create-only, a number is a compare-and-swap against the
 * pinned revision, and omitted stays backward compatible.
 */
export async function putAutomation(
  client: ClientApi,
  automation: Automation,
  expectedRevision?: number | null | undefined,
): Promise<void> {
  checked(
    await client.request({
      type: "automation.put",
      automation: Automation.parse(automation),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  );
}

export async function removeAutomation(
  client: ClientApi,
  id: string,
  expectedRevision?: number | null | undefined,
  source: AutomationSource = "person",
): Promise<void> {
  checked(
    await client.request({
      type: "automation.remove",
      id,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(source === "thread" ? { source } : {}),
    }),
  );
}

/** Pause or resume from the stored definition, so a stale form cannot overwrite it. */
export async function setEnabledAutomation(
  client: ClientApi,
  id: string,
  enabled: boolean,
  expectedRevision?: number | undefined,
  source: AutomationSource = "person",
): Promise<void> {
  checked(
    await client.request({
      type: "automation.setEnabled",
      id,
      enabled,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(source === "thread" ? { source } : {}),
    }),
  );
}

/** Reinitialize a failed trigger; clears the stored trigger error only on success. */
export async function retryAutomation(
  client: ClientApi,
  id: string,
  expectedRevision?: number | undefined,
): Promise<void> {
  checked(
    await client.request({
      type: "automation.retry",
      id,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  );
}

/** How a run is asked for: its idempotency key, a note for this run only, and its store. */
export interface RunRequest {
  requestId?: string | undefined;
  message?: string | undefined;
  source?: AutomationSource | undefined;
}

/**
 * Start a run now, whatever the trigger, with an optional note added after the saved prompt. A
 * caller-supplied requestId makes the intent idempotent across uncertain sends and reloads.
 * Resolves with the run as admitted.
 */
export async function runAutomation(
  client: ClientApi,
  id: string,
  request: RunRequest = {},
): Promise<AutomationRun> {
  const reply = checked(
    await client.request(
      {
        type: "automation.run",
        id,
        variables: {},
        ...(request.message ? { message: request.message } : {}),
        ...(request.source === "thread" ? { source: request.source } : {}),
      },
      request.requestId === undefined ? {} : { requestId: request.requestId },
    ),
  );
  if (!reply.run) throw new AutomationError(undefined);
  return reply.run;
}
