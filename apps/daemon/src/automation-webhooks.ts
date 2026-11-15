/*
 * Webhook automations in the daemon (ADR 0158): the URL each one has on ace cloud, the person's
 * secret controls, and the `/hooks/<hookId>` requests ace's relay forwards. The decisions live in
 * `@ace/automations` (`AutomationWebhooks`); this is the I/O around them.
 *
 * Automations live in two stores: the person's, and the one for automations agents made from
 * threads (`agent-control/owners.ts`). Each keeps its own hook ids and secrets; a request names
 * its store with `source`, and a forwarded hook is served by whichever store has it.
 */
import { randomBytes } from "node:crypto";
import { AutomationWebhooks, type AutomationService, type AutomationStore } from "@ace/automations";
import type {
  AutomationWebhookVia,
  AutomationSource,
  AutomationWebhookRequest,
  AutomationWebhookResponse,
  AutomationWebhookState,
} from "@ace/protocol";
import type { ReachFacts } from "./external-mcp/reach.ts";
import { publicOrigin, tailnetUrl, unreachable } from "./external-mcp/reach.ts";
import { hooksPath, webhookState, type WebhookWays } from "./automation-webhook-reach.ts";
import { RateLimit } from "./external-mcp/oauth/rate-limit.ts";
import type { RelayHttpHandler } from "./relay-http.ts";
import type { ServiceContext } from "./services/types.ts";

export interface AutomationWebhookService {
  /** Whether webhooks are switched on for a way in. */
  enabled(via: AutomationWebhookVia): boolean;
  /** What the person's list shows for a webhook automation. */
  state(automationId: string, source?: AutomationSource): AutomationWebhookState;
  /** The person's rotate and revoke; never reachable from an agent tool. */
  handle(request: AutomationWebhookRequest): AutomationWebhookResponse;
  /** A request ace's relay forwarded to `<prefix>/hooks/<hookId>`. */
  relay: RelayHttpHandler;
  /** A request for `/hooks/<hookId>` on the Tailscale listener or at the person's own URL. */
  serve(request: Request, via: "tailscale" | "custom"): Promise<Response>;
}

/** The switch for each way in (ADR 0158, decision 3), and the person's own URL. */
const switches = {
  relay: "remote.relayWebhooks",
  tailscale: "remote.tailscaleWebhooks",
  custom: "remote.publicUrlWebhooks",
} as const satisfies Record<AutomationWebhookVia, string>;
const watched = [...Object.values(switches), "remote.mcpPublicUrl"] as const;
/** New deliveries each webhook starts runs for, per minute. */
export const webhookRate = { limit: 60, windowMs: 60_000, keys: 2048 };
/** Until the server listens, nothing reaches this machine from outside. */
const noReach = (): ReachFacts => unreachable;

type Source = {
  webhooks: AutomationWebhooks;
  /** Whether the automation still belongs here: an agent's needs its owner thread. */
  live(automationId: string): boolean;
};

export async function startAutomationWebhooks(
  context: ServiceContext,
  store: AutomationStore,
  service: AutomationService,
): Promise<AutomationWebhookService> {
  // Each store has its own ids, so each has its own limit (ADR 0158, decision 10).
  const deps = () => {
    const limit = new RateLimit({ ...webhookRate, now: context.now });
    return {
      now: context.now,
      randomBytes: (size: number) => randomBytes(size),
      allow: (automationId: string) => limit.allow(automationId),
    };
  };
  const person: Source = {
    webhooks: new AutomationWebhooks(store, service, deps()),
    live: () => true,
  };
  // Agent control may start after this; its store is looked up per request.
  let agents: { store: AutomationStore; source: Source } | undefined;
  const sources = (): Record<AutomationSource, Source | undefined> => {
    const current = context.services.agentAutomations;
    if (current && agents?.store !== current.store)
      agents = {
        store: current.store,
        source: {
          webhooks: new AutomationWebhooks(current.store, current.service, deps()),
          live: current.live,
        },
      };
    return { person, thread: current ? agents?.source : undefined };
  };
  let reach = noReach;
  context.onListen.push((server) => {
    reach = () => server.outsideReach();
  });
  // The switches and own URL, kept current so each request reads them without waiting.
  let on: Record<AutomationWebhookVia, boolean> = { relay: false, tailscale: false, custom: false };
  let custom: string | null = null;
  const settings = context.services.settings;
  const read = async () => {
    const entries = (await settings?.read({ keys: [...watched], scope: {} }).catch(() => undefined))
      ?.entries;
    const value = (key: (typeof watched)[number]) =>
      entries?.find((entry) => entry.key === key)?.value;
    on = {
      relay: value(switches.relay) === true,
      tailscale: value(switches.tailscale) === true,
      custom: value(switches.custom) === true,
    };
    const url = value("remote.mcpPublicUrl");
    custom = typeof url === "string" ? publicOrigin(url) : null;
  };
  if (settings) {
    const release = await settings.subscribe({ keys: [...watched], scope: {} }, (event) => {
      if (event.type === "changed") void read();
    });
    context.resources.own(release);
    await read();
  }
  const ways = (): WebhookWays => {
    const tailscale = on.tailscale ? reach().tailscale() : undefined;
    const relay = on.relay ? reach().relay() : undefined;
    return {
      custom: !on.custom
        ? { on: false }
        : custom
          ? { on: true, base: custom }
          : { on: true, problem: "Add your own URL in Settings, under Connect an app." },
      tailscale: !tailscale
        ? { on: false }
        : "problem" in tailscale
          ? { on: true, problem: tailscale.problem }
          : { on: true, base: tailnetUrl(tailscale) },
      relay: !relay
        ? { on: false }
        : "problem" in relay
          ? { on: true, problem: relay.problem }
          : { on: true, base: `${relay.origin}/m/${relay.hostId}` },
    };
  };
  const state = (
    automationId: string,
    source: AutomationSource = "person",
  ): AutomationWebhookState =>
    webhookState(sources()[source]?.webhooks.hookOf(automationId), ways());
  /** One request on a way in, whose webhooks start at `<prefix>/hooks/`. */
  const serve = async (
    request: Request,
    via: AutomationWebhookVia,
    prefix: string,
  ): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const start = prefix + hooksPath;
    if (!on[via] || !path.startsWith(start)) return answer(404, { error: "not_found" });
    // The ADR's order: the method before anything about the hook.
    if (request.method !== "POST") return answer(405, { error: "method_not_allowed" });
    const hookId = path.slice(start.length);
    const owner = Object.values(sources()).find((source) => {
      const automationId = source?.webhooks.ownerOf(hookId);
      return automationId !== undefined && source?.live(automationId);
    });
    if (!owner) return answer(404, { error: "not_found" });
    const body = new Uint8Array(await request.arrayBuffer());
    request.signal.throwIfAborted();
    const result = owner.webhooks.receive(hookId, {
      method: request.method,
      headers: request.headers,
      body,
    });
    return answer(result.status, result.body);
  };
  return {
    enabled: (via) => on[via],
    state,
    handle(request) {
      const base = { type: "automation.webhookResult" as const, requestId: request.requestId };
      const source = request.source ?? "person";
      const owner = sources()[source];
      if (!owner || !owner.live(request.id)) return { ...base, ok: false, error: "not_found" };
      try {
        if (request.action === "revoke") {
          owner.webhooks.revoke(request.id);
          return { ...base, ok: true, webhook: state(request.id, source) };
        }
        const { secret } = owner.webhooks.rotate(request.id);
        return { ...base, ok: true, webhook: state(request.id, source), secret };
      } catch (error) {
        return {
          ...base,
          ok: false,
          error: error instanceof Error ? error.message : "webhook_failed",
        };
      }
    },
    relay: async (request, signal, forwarded) => {
      signal.throwIfAborted();
      return serve(request, "relay", forwarded.prefix);
    },
    serve: (request, via) => serve(request, via, ""),
  };
}

function answer(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(status === 429 ? { "retry-after": String(webhookRate.windowMs / 1000) } : {}),
    },
  });
}
