import type { AccessMode, AutomationWebhookState, AutomationWebhookVia } from "@ace/protocol";
import { accessLabel } from "../permissions.ts";

/*
 * A webhook automation's words (ADR 0173), shared by the web panel and the phone: each way in's
 * name, what its runs may do, the confirms before Rotate and Revoke, what holding the secret
 * allows, the headers senders sign with and the prompt's variables, and the machine's switches.
 */

export const webhookViaNames: Record<AutomationWebhookVia, string> = {
  custom: "Your URL",
  tailscale: "Tailscale",
  relay: "ace cloud",
};

/**
 * Whose access a webhook's runs get (decision 9): an agent's runs in its own thread, at that
 * thread's access; the person's runs at its own access, else read-only.
 */
export type WebhookRunsAt = { thread: true } | { thread: false; access: AccessMode | undefined };

/** The quiet line under the addresses: read-only by default, a warning at full access. */
export function webhookAccessLine(
  runsAt: WebhookRunsAt,
): { text: string; warn: boolean } | undefined {
  if (runsAt.thread) return undefined;
  if (runsAt.access === undefined)
    return { text: "Runs read-only, since a webhook's text comes from outside.", warn: false };
  if (runsAt.access === "full-access")
    return { text: "Anyone with the secret can steer an agent with full access.", warn: true };
  return undefined;
}

/** What the secret's text reaches, said where it is shown (ADR 0173, Consequences). */
export function webhookReach(runsAt: WebhookRunsAt): string {
  if (runsAt.thread) return "It runs in its agent's thread, at that thread's access.";
  if (runsAt.access === undefined) return "It runs read-only unless you change its access.";
  const label = accessLabel(runsAt.access);
  // "Full access" already says access; "Read-only" doesn't.
  return /access$/i.test(label) ? `It runs with ${label}.` : `It runs with ${label} access.`;
}

/** Said beside a secret just made: it is shown this once. */
export function webhookSecretNote(runsAt: WebhookRunsAt): string {
  return `Copy it now: it won't be shown again. Anyone with it can send text into this automation's prompt. ${webhookReach(runsAt)}`;
}

/** Where the addresses would be, when there are none: why, or what comes first. */
export function webhookAddressGap(
  webhook: AutomationWebhookState | undefined,
): { text: string; warn: boolean } | undefined {
  if (webhook?.urls.length) return undefined;
  if (webhook?.problem) return { text: webhook.problem, warn: true };
  return { text: webhook?.active ? "No address" : "No secret yet", warn: false };
}

export const webhookConfirms = {
  rotate: {
    title: "Rotate this webhook's secret?",
    body: "The current secret stops working at once. Senders need the new one.",
    confirm: "Rotate secret",
  },
  revoke: {
    title: "Revoke this webhook's secret?",
    body: "The secret stops working and the address stops answering. A new secret gets a new address.",
    confirm: "Revoke",
  },
} as const;

/** The Standard Webhooks headers a sender signs with. */
export const webhookHeaders = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;
/** What a prompt can read from a delivery, each with what it means. */
export const webhookVariables = [
  { name: "{{body.field}}", means: "a JSON body field" },
  { name: "{{body.a.b}}", means: "nested" },
  { name: "{{body.items.0}}", means: "an array item" },
  { name: "{{webhook.id}}", means: "the delivery id" },
] as const;

/**
 * Settings › a machine › Automation webhooks: one switch per way a signed webhook can reach the
 * machine (decision 3), each with what it means for a request's body.
 */
export const webhookWays = {
  custom: {
    title: "At your own URL",
    label: "Automation webhooks at your own URL",
    sub: "Senders reach your own proxy, which keeps request bodies off ace cloud.",
    blocked: "Add your own URL under Connect an app first.",
  },
  tailscale: {
    title: "Over Tailscale",
    label: "Automation webhooks over Tailscale",
    sub: "Senders reach this machine's ts.net name, which keeps request bodies off ace cloud.",
  },
  relay: {
    title: "Through ace cloud",
    label: "Automation webhooks through ace cloud",
    sub: "ace cloud carries webhook bodies in plain text, never the secret.",
  },
} as const;
