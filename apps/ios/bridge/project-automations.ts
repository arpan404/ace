import type { ClientCore } from "@ace/client";
import { automationLists, type AutomationEntry } from "@ace/ui-core/automations";
import { z } from "zod";

/*
 * The reads the person's automations take beyond their own page: whether the machine runs them
 * at all, and the person's list with that answer, as a thread's Summary words its project's
 * schedules from (`@ace/ui-core/automations` `projectAutomationsLine`).
 */

type Owner = Pick<ClientCore, "request">;
const timeout = { timeoutMs: 20_000 };
const Setting = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });

/** Whether the machine runs automations (`automations.enabled`); undefined when unread. */
export async function machineRunsAutomations(
  owner: Owner,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const reply = await owner
    .request(
      { type: "settings.get", key: "automations.enabled", scope: {} },
      { ...(signal ? { signal } : {}), ...timeout },
    )
    .catch(() => undefined);
  const value = Setting.safeParse(reply).data?.entries?.[0]?.value;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The person's automations and whether the machine runs them. `none` when the machine has no
 * automations service (nothing to say), `failed` when the read didn't come back.
 */
export type PersonAutomations =
  | { kind: "read"; entries: AutomationEntry[]; running: boolean | undefined }
  | { kind: "none" }
  | { kind: "failed" };

export async function readPersonAutomations(
  owner: Owner,
  signal?: AbortSignal,
): Promise<PersonAutomations> {
  try {
    const [reply, running] = await Promise.all([
      owner.request({ type: "automation.list" }, { ...(signal ? { signal } : {}), ...timeout }),
      machineRunsAutomations(owner, signal),
    ]);
    if (reply.ok) return { kind: "read", entries: automationLists(reply).person, running };
    return reply.error === "automation_unavailable" ? { kind: "none" } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
