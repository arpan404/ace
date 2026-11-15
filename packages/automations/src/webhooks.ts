/*
 * Webhook automations (ADR 0158): the person's secret controls and what one signed request does.
 * No HTTP here: the daemon hands in the method, headers and raw body and sends back the answer.
 */
import type { AutomationService } from "./service.ts";
import type { AutomationStore } from "./store.ts";
import { webhookBodyLimits, webhookVariables } from "./webhook-body.ts";
import {
  newWebhookSecret,
  readWebhookHeaders,
  verifyWebhook,
  webhookToleranceMs,
} from "./webhook-signature.ts";

export type WebhookRequest = { method: string; headers: Headers; body: Uint8Array };
export type WebhookError =
  | "method_not_allowed"
  | "not_found"
  | "too_large"
  | "unsupported_media_type"
  | "bad_headers"
  | "stale_timestamp"
  | "bad_signature"
  | "bad_body"
  | "disabled"
  | "unavailable";
export type WebhookAnswer =
  | { status: 202; body: { runId: string } }
  | { status: number; body: { error: WebhookError; message?: string } };

const statuses: Record<WebhookError, number> = {
  method_not_allowed: 405,
  not_found: 404,
  too_large: 413,
  unsupported_media_type: 415,
  bad_headers: 400,
  stale_timestamp: 400,
  bad_signature: 401,
  bad_body: 422,
  disabled: 409,
  unavailable: 503,
};
const refuse = (error: WebhookError, message?: string): WebhookAnswer => ({
  status: statuses[error],
  body: message === undefined ? { error } : { error, message },
});
export type WebhookDependencies = { now(): number; randomBytes(size: number): Uint8Array };
/** A hook id in a URL: 128 bits in lowercase hex. */
export const hookIdPattern = /^[0-9a-f]{32}$/;
const json = /^application\/json\s*(;|$)/i;

export class AutomationWebhooks {
  private readonly store: AutomationStore;
  private readonly service: AutomationService;
  private readonly deps: WebhookDependencies;
  constructor(store: AutomationStore, service: AutomationService, deps: WebhookDependencies) {
    this.store = store;
    this.service = service;
    this.deps = deps;
  }

  /**
   * A new secret for a webhook automation, and its hook id (made the first time, kept after).
   * The secret is returned here only; nothing reads it back out but the signature check.
   */
  rotate(automationId: string): { hookId: string; secret: string } {
    const automation = this.store.definition(automationId);
    if (!automation) throw new Error("Automation is missing");
    if (automation.trigger.kind !== "webhook") throw new Error("Automation isn't a webhook");
    const secret = newWebhookSecret((size) => this.deps.randomBytes(size));
    const fresh = Buffer.from(this.deps.randomBytes(16)).toString("hex");
    return { hookId: this.store.webhooks.rotate(automationId, fresh, secret), secret };
  }

  /** Deletes the secret and hook id; the URL answers 404 from the next request. */
  revoke(automationId: string): void {
    this.store.webhooks.forget(automationId);
  }

  /** Which automation a hook id belongs to, if any. */
  ownerOf(hookId: string): string | undefined {
    return hookIdPattern.test(hookId)
      ? this.store.webhooks.byHook(hookId)?.automationId
      : undefined;
  }

  /** The automation's hook id while it has a secret. */
  hookOf(automationId: string): string | undefined {
    return this.store.webhooks.hookOf(automationId);
  }

  /**
   * One request to `/hooks/<hookId>`. Checks run in the ADR's order, so a caller without the
   * secret learns only whether the hook exists; the answer comes on admission, never on the
   * agent's finish.
   */
  receive(hookId: string, request: WebhookRequest): WebhookAnswer {
    if (request.method !== "POST") return refuse("method_not_allowed");
    const key = hookIdPattern.test(hookId) ? this.store.webhooks.byHook(hookId) : undefined;
    const automation = key ? this.store.definition(key.automationId) : undefined;
    if (!key || automation?.trigger.kind !== "webhook") return refuse("not_found");
    if (request.body.byteLength > webhookBodyLimits.bytes) return refuse("too_large");
    if (!json.test(request.headers.get("content-type") ?? ""))
      return refuse("unsupported_media_type");
    const headers = readWebhookHeaders(request.headers);
    if (!headers.ok) return refuse("bad_headers");
    const check = verifyWebhook(key.secret, headers.headers, request.body, this.deps.now());
    if (check !== "ok") return refuse(check);
    const variables = webhookVariables(request.body, headers.headers.id);
    if (!variables.ok) return refuse(variables.error, variables.message);
    // A delivery already admitted answers with its run, whatever has changed since.
    const deliveryId = headers.headers.id;
    const earlier = this.store.webhooks.delivered(automation.id, deliveryId);
    if (earlier !== undefined) return { status: 202, body: { runId: earlier } };
    if (!automation.enabled) return refuse("disabled");
    try {
      const run = this.service.trigger(
        automation.id,
        { key: `webhook:${deliveryId}`, variables: variables.variables },
        "webhook",
      );
      // Synchronous from the check above, so no second request can come between. A crash
      // before this line leaves the run's event key, which still finds it until it is pruned.
      this.store.webhooks.deliver(
        automation.id,
        deliveryId,
        run.id,
        headers.headers.timestamp * 1000 + webhookToleranceMs,
        this.deps.now(),
      );
      return { status: 202, body: { runId: run.id } };
    } catch {
      return refuse("unavailable");
    }
  }
}
