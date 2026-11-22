import type { ClientCore } from "@ace/client";
import { AutomationSource, type AutomationWebhookState } from "@ace/protocol";
import {
  automationErrorMessage,
  automationLists,
  webhookAccessLine,
  webhookAddressGap,
  webhookConfirms,
  webhookHeaders,
  webhookSecretNote,
  webhookVariables,
  webhookViaNames,
  type AutomationEntry,
  type WebhookRunsAt,
} from "@ace/ui-core/automations";
import { z } from "zod";

/*
 * A webhook automation on the phone (ADR 0173): its addresses, the access its runs get, and the
 * person's Create, Rotate and Revoke. The secret comes back only in the reply to the rotate that
 * made it; nothing here keeps it, logs it or reads it again. Words come from
 * `@ace/ui-core/automations`, the same as the web's panel.
 */

const id = z.string().min(1).max(256);

/** The webhook part of an automation's screen, read on every visit. */
export const WebhookStateRequest = z.object({
  type: z.literal("automations.webhook"),
  automationId: id,
  source: AutomationSource.optional(),
});
/**
 * Create the first secret, or Rotate or Revoke it; the phone asks the person before the last two.
 * `create` makes a secret only while there is none, so it never replaces a live one unasked.
 */
export const WebhookSecretRequest = z.object({
  type: z.literal("automations.webhook.secret"),
  automationId: id,
  source: AutomationSource.optional(),
  action: z.enum(["create", "rotate", "revoke"]),
});
export type WebhookStateRequest = z.infer<typeof WebhookStateRequest>;
export type WebhookSecretRequest = z.infer<typeof WebhookSecretRequest>;

type Owner = Pick<ClientCore, "request">;
type Reply = Record<string, unknown> & { ok: boolean };
const timeout = { timeoutMs: 20_000 };
const refused = (code: string | undefined): Reply => ({
  ok: false,
  error: automationErrorMessage(code),
});
const notWebhook: Reply = { ok: false, error: "That automation doesn't run on a webhook." };
/** Create found a secret made elsewhere after the page was read: Rotate, confirmed, replaces it. */
const madeElsewhere = "A secret was created elsewhere. Rotate it instead?";

/** What the phone draws: every line worded, the confirms, and what senders and prompts use. */
export function webhookView(webhook: AutomationWebhookState | undefined, runsAt: WebhookRunsAt) {
  return {
    active: webhook?.active === true,
    addresses: (webhook?.urls ?? []).map((entry) => ({
      via: entry.via,
      name: webhookViaNames[entry.via],
      url: entry.url,
    })),
    gap: webhookAddressGap(webhook) ?? null,
    access: webhookAccessLine(runsAt) ?? null,
    confirms: webhookConfirms,
    headers: [...webhookHeaders],
    variables: webhookVariables.map(({ name, means }) => ({ name, means })),
  };
}

const runsAtOf = (entry: AutomationEntry): WebhookRunsAt =>
  entry.owner === undefined ? { thread: false, access: entry.automation.access } : { thread: true };

/** The automation's entry from the list, in the store `source` names. */
async function entryOf(
  owner: Owner,
  automationId: string,
  source: AutomationSource | undefined,
  signal: AbortSignal,
): Promise<AutomationEntry | Reply> {
  const reply = await owner.request(
    { type: "automation.list", ...(source === "thread" ? { includeThreads: true } : {}) },
    { signal, ...timeout },
  );
  if (!reply.ok) return refused(reply.error);
  const lists = automationLists(reply);
  const entry = (source === "thread" ? lists.threads : lists.person).find(
    (candidate) => candidate.automation.id === automationId,
  );
  if (!entry) return refused("Automation is missing");
  return entry;
}
const isEntry = (value: AutomationEntry | Reply): value is AutomationEntry => "automation" in value;

export async function webhookState(
  owner: Owner,
  request: WebhookStateRequest,
  signal: AbortSignal,
): Promise<Reply> {
  const entry = await entryOf(owner, request.automationId, request.source, signal);
  if (!isEntry(entry)) return entry;
  if (entry.automation.trigger.kind !== "webhook") return notWebhook;
  return { ok: true, webhook: webhookView(entry.webhook, runsAtOf(entry)) };
}

/**
 * Create, or Rotate or Revoke after the person confirmed. The reply carries the new secret this
 * once, with what holding it allows; a revoke's reply has none. The daemon has no "only if none"
 * rotate, so Create reads the list again just before it writes and refuses while a secret is
 * live, with that secret's addresses for the page to draw and `exists` to offer Rotate.
 */
export async function webhookSecret(
  owner: Owner,
  request: WebhookSecretRequest,
  signal: AbortSignal,
): Promise<Reply> {
  const entry = await entryOf(owner, request.automationId, request.source, signal);
  if (!isEntry(entry)) return entry;
  if (entry.automation.trigger.kind !== "webhook") return notWebhook;
  if (request.action === "create" && entry.webhook?.active)
    return {
      ok: false,
      exists: true,
      error: madeElsewhere,
      webhook: webhookView(entry.webhook, runsAtOf(entry)),
    };
  const reply = await owner.request(
    {
      type: "automation.webhook",
      id: request.automationId,
      action: request.action === "revoke" ? "revoke" : "rotate",
      ...(request.source === "thread" ? { source: "thread" as const } : {}),
    },
    { signal, ...timeout },
  );
  if (!reply.ok) return refused(reply.error);
  const runsAt = runsAtOf(entry);
  const secret = request.action === "revoke" ? null : (reply.secret ?? null);
  return {
    ok: true,
    webhook: webhookView(reply.webhook ?? entry.webhook, runsAt),
    secret,
    note: secret ? webhookSecretNote(runsAt) : null,
  };
}
