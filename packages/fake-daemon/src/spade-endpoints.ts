import type { FakeSpadeAccounts } from "./spade-accounts.ts";
import type { FakeSpadeAgent } from "./spade-agent.ts";
import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * The fake Spade's endpoint, model-check and keychain routes (ADR 0126). They act on the state
 * of the fake API that owns them, so each takes it as its `host`.
 */

type Json = Record<string, unknown>;

/** The fake API's state these routes read and change. */
export interface EndpointHost {
  agents: FakeSpadeAgent[];
  endpoints: Json[];
  presets: Json[];
  readonly accounts: FakeSpadeAccounts;
  keychain: boolean;
  keyFailure: number | undefined;
  liveModels: Map<string, Json[] | number>;
  localServers: Json[];
  localChecks: Map<string, "passed" | "failed">;
  checking: Json[];
  checkShown: WeakSet<Json>;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export function endChecks(host: EndpointHost): void {
  const shown = host.checking.filter((model) => host.checkShown.has(model));
  for (const model of host.checking) host.checkShown.add(model);
  host.checking = host.checking.filter((model) => !shown.includes(model));
  for (const model of shown) {
    const tools = host.localChecks.get(String(model.id)) ?? "passed";
    model.capabilities = tools === "passed" ? ["tools"] : [];
    model.probes = {
      state: "checked",
      plain: "passed",
      tools,
      structured: "passed",
      why:
        tools === "passed"
          ? null
          : "This model didn't call tools in Spade's check, so it can't run a bot.",
    };
  }
}

export function useLocalModel(host: EndpointHost, server: string, model: string): FakeSpadeAnswer {
  const local = host.localServers.find((candidate) => candidate.id === server);
  if (!local || !model.trim()) return problem(404, "No such model server.");
  let endpoint = host.endpoints.find((candidate) => candidate.base_url === local.base_url);
  if (!endpoint) {
    endpoint = {
      id: server,
      name: local.name,
      format: "openai-chat",
      base_url: local.base_url,
      header_names: [],
      session_header: null,
      needs_key: false,
      key_set: false,
      key_source: null,
      models: [],
    };
    host.endpoints.push(endpoint);
    local.endpoint = server;
  }
  const models = endpoint.models as Json[];
  if (!models.some((saved) => saved.id === model)) {
    const added: Json = {
      id: model,
      source: "typed",
      capabilities: [],
      probes: { state: "checking" },
    };
    models.push(added);
    host.checking.push(added);
  }
  return reply({ endpoint, value: `${String(endpoint.id)}/${model.trim()}` });
}

export function endpointRoute(
  host: EndpointHost,
  method: string,
  id: string | undefined,
  sub: string | undefined,
  body: Json,
  query: string,
): FakeSpadeAnswer {
  if (id && sub === "probe" && method === "POST") {
    const endpoint = host.endpoints.find((candidate) => candidate.id === id);
    const model = (endpoint?.models as Json[] | undefined)?.find((each) => each.id === body.id);
    if (!endpoint || !model) return problem(404, "no such model");
    model.probes = { state: "checking" };
    host.checking.push(model);
    return reply({ probes: model.probes }, 202);
  }
  if (!id && method === "POST") return host.accounts.add(body, host.presets, host.endpoints);
  const endpoint = host.endpoints.find((candidate) => candidate.id === id);
  if (!endpoint) return problem(404, "No such endpoint.");
  if (sub === "sign-out" && method === "POST") return host.accounts.signOut(endpoint);
  if (sub === "models") {
    if (method === "GET") {
      const live = host.liveModels.get(String(id));
      if (typeof live === "number") return problem(live, "The endpoint didn't answer.");
      return reply({ models: live ?? [] });
    }
    const models = (endpoint.models as Json[]) ?? [];
    if (method === "POST") {
      endpoint.models = [
        ...models.filter((model) => model.id !== body.id),
        { ...body, source: "typed" },
      ];
      return reply({ endpoint });
    }
    if (method === "DELETE") {
      const model = new URLSearchParams(query).get("id");
      endpoint.models = models.filter((candidate) => candidate.id !== model);
      return { status: 204 };
    }
  }
  if (method === "PATCH") {
    Object.assign(endpoint, body);
    return reply({ endpoint });
  }
  if (method === "DELETE") {
    const users = host.agents.filter((agent) => agent.model.startsWith(`${String(id)}/`));
    if (users.length)
      return problem(409, `${users.map((agent) => agent.name).join(", ")} use this endpoint.`);
    host.endpoints = host.endpoints.filter((candidate) => candidate !== endpoint);
    return { status: 204 };
  }
  return problem(405, "Not allowed.");
}

export function keyRoute(
  host: EndpointHost,
  method: string,
  id: string,
  sub?: string,
): FakeSpadeAnswer {
  const endpoint = host.endpoints.find((candidate) => candidate.id === id);
  if (!endpoint) return problem(404, "No such endpoint.");
  if (!host.keychain) return problem(503, "This machine has no keychain.");
  if (host.keyFailure) return problem(host.keyFailure, "The keychain refused the key.");
  // A gateway token is its own keychain entry: the endpoint's own key stays as it was.
  if (sub === "gateway") {
    endpoint.gateway_token_set = method === "PUT";
    return { status: 204 };
  }
  endpoint.key_set = method === "PUT";
  endpoint.key_source = method === "PUT" ? "keychain" : null;
  return { status: 204 };
}
