/*
 * Which addresses a webhook automation has (ADR 0158, decision 3). Pure: the person's switches
 * and what each way in knows about itself in, the state the person's apps show out. Ways ace
 * cloud doesn't carry come first, so the first URL keeps request bodies off ace cloud.
 */
import type { AutomationWebhookState, AutomationWebhookVia } from "@ace/protocol";

export const hooksPath = "/hooks/";

/** One way in: off, on but unable to serve (and why), or on at a base URL without a slash. */
export type WebhookWay = { on: false } | { on: true; base: string } | { on: true; problem: string };
export type WebhookWays = Record<AutomationWebhookVia, WebhookWay>;

const order: readonly AutomationWebhookVia[] = ["custom", "tailscale", "relay"];
export const noWayOn =
  "Turn on a way in for automation webhooks in Settings: your own URL, Tailscale or ace cloud.";

export function webhookState(
  hookId: string | undefined,
  ways: WebhookWays,
): AutomationWebhookState {
  if (hookId === undefined) return { active: false, path: null, url: null, urls: [] };
  const path = `${hooksPath}${hookId}`;
  const urls = order.flatMap((via) => {
    const way = ways[via];
    return way.on && "base" in way ? [{ via, url: `${way.base}${path}` }] : [];
  });
  const first = urls[0];
  if (first) return { active: true, path, url: first.url, urls };
  const blocked = order.map((via) => ways[via]).find((way) => way.on && "problem" in way);
  return {
    active: true,
    path,
    url: null,
    urls,
    problem: blocked && "problem" in blocked ? blocked.problem.slice(0, 512) : noWayOn,
  };
}
