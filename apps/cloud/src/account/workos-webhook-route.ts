import type { OrgEvents } from "./org-events.ts";
import { fail, json } from "./respond.ts";
import { WEBHOOK_MAX_BYTES, verifiedWebhook } from "./workos-webhook.ts";

/**
 * POST /v1/workos/webhook: WorkOS's webhook deliveries (ADR 0206 §6), so a directory's
 * deprovisioning ends a member's org access in seconds rather than at the minute's Events API
 * run. A delivery counts only with a valid, recent `WorkOS-Signature`. A membership, user or
 * organization event is applied at once through the same code as the feed; a Directory Sync
 * (`dsync.*`) event, which WorkOS turns into membership changes of its own, has the feed caught
 * up now. Anything else is acknowledged and ignored. Applying is idempotent and ordered by
 * WorkOS's own times, so a repeat or an out-of-order delivery is harmless.
 */
export function workosWebhookRoute(deps: {
  secret: string | undefined;
  events: Pick<OrgEvents, "deliver" | "catchUp">;
  now: () => number;
}) {
  return async (request: Request): Promise<Response> => {
    const { secret } = deps;
    if (!secret) return fail(404, "not_found");
    const length = Number(request.headers.get("Content-Length") ?? 0);
    if (!Number.isFinite(length) || length > WEBHOOK_MAX_BYTES) return fail(413, "too_large");
    const body = await request.text();
    if (body.length > WEBHOOK_MAX_BYTES) return fail(413, "too_large");
    const event = await verifiedWebhook(
      secret,
      request.headers.get("WorkOS-Signature"),
      body,
      deps.now(),
    );
    if (!event) return fail(401, "invalid_signature");
    if (event.event.startsWith("dsync.")) {
      try {
        await deps.events.catchUp();
      } catch {
        // The minute's run catches up anyway; WorkOS needn't deliver this again.
      }
      return json(200, { ok: true });
    }
    // A failure here is WorkOS's to retry: the delivery wasn't applied.
    await deps.events.deliver(event);
    return json(200, { ok: true });
  };
}
