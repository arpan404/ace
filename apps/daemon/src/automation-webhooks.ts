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
  AutomationSource,
  AutomationWebhookRequest,
  AutomationWebhookResponse,
  AutomationWebhookState,
} from "@ace/protocol";
import type { ReachFacts } from "./external-mcp/reach.ts";
import { unreachable } from "./external-mcp/reach.ts";
import type { RelayHttpHandler } from "./relay-http.ts";
import type { ServiceContext } from "./services/types.ts";

export interface AutomationWebhookService {
  /** Whether `remote.relayWebhooks` is on. */
  enabled(): boolean;
  /** What the person's list shows for a webhook automation. */
  state(automationId: string, source?: AutomationSource): AutomationWebhookState;
  /** The person's rotate and revoke; never reachable from an agent tool. */
  handle(request: AutomationWebhookRequest): AutomationWebhookResponse;
  /** A request ace's relay forwarded to `<prefix>/hooks/<hookId>`. */
  relay: RelayHttpHandler;
}

const setting = "remote.relayWebhooks";
export const hooksPath = "/hooks/";
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
  const deps = { now: context.now, randomBytes: (size: number) => randomBytes(size) };
  const person: Source = {
    webhooks: new AutomationWebhooks(store, service, deps),
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
          webhooks: new AutomationWebhooks(current.store, current.service, deps),
          live: current.live,
        },
      };
    return { person, thread: current ? agents?.source : undefined };
  };
  let reach = noReach;
  context.onListen.push((server) => {
    reach = () => server.outsideReach();
  });
  let on = false;
  const settings = context.services.settings;
  if (settings) {
    const release = await settings.subscribe({ keys: [setting], scope: {} }, (notification) => {
      if (notification.type !== "changed") return;
      const entry = notification.entries.find((candidate) => candidate.key === setting);
      if (entry) on = entry.value === true;
    });
    context.resources.own(release);
    on = (await settings.get(setting)).value === true;
  }
  const state = (
    automationId: string,
    source: AutomationSource = "person",
  ): AutomationWebhookState => {
    const hookId = sources()[source]?.webhooks.hookOf(automationId);
    if (hookId === undefined) return { active: false, path: null, url: null };
    const path = `${hooksPath}${hookId}`;
    if (!on)
      return {
        active: true,
        path,
        url: null,
        problem: "Turn on Automation webhooks through ace cloud in Settings.",
      };
    const relay = reach().relay();
    if ("problem" in relay) return { active: true, path, url: null, problem: relay.problem };
    return { active: true, path, url: `${relay.origin}/m/${relay.hostId}${path}` };
  };
  return {
    enabled: () => on,
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
    async relay(request, signal, forwarded) {
      const path = new URL(request.url).pathname;
      const start = forwarded.prefix + hooksPath;
      if (!on || !path.startsWith(start)) return answer(404, { error: "not_found" });
      // The ADR's order: the method before anything about the hook.
      if (request.method !== "POST") return answer(405, { error: "method_not_allowed" });
      const hookId = path.slice(start.length);
      const owner = Object.values(sources()).find((source) => {
        const automationId = source?.webhooks.ownerOf(hookId);
        return automationId !== undefined && source?.live(automationId);
      });
      if (!owner) return answer(404, { error: "not_found" });
      const body = new Uint8Array(await request.arrayBuffer());
      signal.throwIfAborted();
      const result = owner.webhooks.receive(hookId, {
        method: request.method,
        headers: request.headers,
        body,
      });
      return answer(result.status, result.body);
    },
  };
}

function answer(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
