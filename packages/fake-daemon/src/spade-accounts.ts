import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Providers and accounts (ADR 0214) for the fake API, in Spade's JSON: what `GET /v1/models`
 * adds to each endpoint (its provider, how it signs in, the ChatGPT account, the bots on it),
 * adding an account from a preset or an address, and ChatGPT sign-ins that end after a read or
 * two. No real sign-in happens and no token exists here.
 */

type Json = Record<string, unknown>;

const answer = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => answer({ error }, status);

/** The models a ChatGPT account's backend lists, as the fake's sign-ins have them. */
const chatgptModels = (): Json[] => [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    context: 400_000,
    capabilities: ["images", "tools"],
    source: "listed",
  },
  {
    id: "gpt-5.5-mini",
    name: "GPT-5.5 Mini",
    context: 400_000,
    capabilities: ["tools"],
    source: "listed",
  },
];

/** An id from a name, unique among `taken`: its slug, then `-2` and on. */
function freeId(name: string, taken: readonly Json[]): string {
  const slug = name.toLowerCase().replaceAll(/\W+/g, "-").replaceAll(/^-|-$/g, "") || "endpoint";
  const used = new Set(taken.map((each) => String(each.id)));
  if (!used.has(slug)) return slug;
  let next = 2;
  while (used.has(`${slug}-${next}`)) next += 1;
  return `${slug}-${next}`;
}

interface Flow {
  json: Json;
  reads: number;
  /** The signed-out account it signs back in, if any. */
  account: string | undefined;
}

export class FakeSpadeAccounts {
  /** The sign-ins this Spade can run, as `GET /v1/models` says (`sign_in`). */
  signIn: string[] = ["chatgpt"];
  /** Reads a waiting sign-in answers before it ends. */
  readsToEnd = 2;
  /** How the next sign-ins end. */
  ending: "done" | "failed" = "done";
  /** Who the next sign-in signs in as. */
  signInAs = { email: "sam@example.com", plan: "plus" };
  /** A status starting a sign-in answers with instead (409: the callback port is taken). */
  startFailure: number | undefined;
  /** Every sign-in started, by id. */
  readonly flows = new Map<string, Flow>();

  /** The endpoints as `GET /v1/models` lists them: each with its provider, sign-in and bots. */
  listed(endpoints: readonly Json[], agents: readonly { name: string; model: string }[]): Json[] {
    return endpoints.map((endpoint) => ({
      provider: null,
      auth: endpoint.needs_key === false ? "none" : "key",
      account: null,
      ...endpoint,
      used_by: agents
        .filter((agent) => agent.model.startsWith(`${String(endpoint.id)}/`))
        .map((agent) => agent.name)
        .toSorted((a, b) => a.localeCompare(b)),
    }));
  }

  /**
   * `POST /v1/endpoints`: an account from a preset (`{preset, name}` is enough: the preset fills
   * in the rest) or from its address. Its id is a slug of its name, `-2` and on when taken.
   */
  add(body: Json, presets: readonly Json[], endpoints: Json[]): FakeSpadeAnswer {
    const preset = presets.find((each) => each.id === body.preset);
    const name = String(body.name ?? preset?.name ?? "endpoint");
    const needsKey = body.needs_key !== false;
    const endpoint: Json = {
      id: freeId(name, endpoints),
      name,
      format: body.format ?? preset?.format,
      base_url: body.base_url ?? preset?.base_url,
      header_names: Object.keys((body.headers as Json | undefined) ?? {}),
      session_header: body.session_header ?? preset?.session_header ?? null,
      needs_key: needsKey,
      key_set: false,
      key_source: null,
      gateway_token_set: Boolean(body.gateway_token),
      provider: preset ? preset.id : null,
      auth: needsKey ? "key" : "none",
      account: null,
      // A preset's models come with an account made from it.
      models: ((preset?.models as Json[] | undefined) ?? []).map((model) =>
        Object.assign({}, model, { source: "preset" }),
      ),
    };
    endpoints.push(endpoint);
    return answer({ endpoint }, 201);
  }

  /** `/v1/accounts/chatgpt[/{flow}]`. */
  route(method: string, id: string | undefined, body: Json, endpoints: Json[]): FakeSpadeAnswer {
    if (!id && method === "POST") return this.start(body, endpoints);
    const flow = id ? this.flows.get(id) : undefined;
    if (!flow) return problem(404, "No such sign-in.");
    if (method === "DELETE") {
      if (flow.json.state === "waiting") flow.json.state = "cancelled";
      return { status: 204 };
    }
    if (method !== "GET") return problem(405, "Not allowed.");
    flow.reads += 1;
    if (flow.json.state === "waiting" && flow.reads >= this.readsToEnd) this.end(flow, endpoints);
    return answer({ flow: flow.json });
  }

  /** `POST /v1/endpoints/{id}/sign-out`: the tokens go, the account and its bots stay. */
  signOut(endpoint: Json): FakeSpadeAnswer {
    if (endpoint.auth !== "chatgpt") return problem(400, "This account doesn't sign in.");
    endpoint.account = { ...(endpoint.account as Json | undefined), signed_in: false };
    return answer({ endpoint });
  }

  private start(body: Json, endpoints: readonly Json[]): FakeSpadeAnswer {
    if (body.terms_read !== true)
      return problem(400, "Confirm you've read what a ChatGPT sign-in means first.");
    if (body.method !== "browser" && body.method !== "device")
      return problem(400, "Sign in with browser or device.");
    if (this.startFailure)
      return problem(
        this.startFailure,
        "Another sign-in is using the callback port. Sign in with a code instead.",
      );
    const account = typeof body.account === "string" ? body.account : undefined;
    if (account && !endpoints.some((each) => each.id === account && each.auth === "chatgpt"))
      return problem(404, "No such ChatGPT account.");
    const id = `flow-${this.flows.size + 1}`;
    const device = body.method === "device";
    const json: Json = {
      id,
      method: body.method,
      state: "waiting",
      url: device
        ? "https://auth.openai.com/codex/device"
        : `https://auth.openai.com/oauth/authorize?client=spade&state=${id}`,
      user_code: device ? "WXYZ-2468" : null,
      endpoint: null,
      error: null,
    };
    this.flows.set(id, { json, reads: 0, account });
    return answer({ flow: json }, 201);
  }

  /** The sign-in ends: the account named, the one of that email, or a new one. */
  private end(flow: Flow, endpoints: Json[]): void {
    if (this.ending === "failed") {
      flow.json.state = "failed";
      flow.json.error = "OpenAI didn't finish the sign-in. Try again.";
      return;
    }
    const { email, plan } = this.signInAs;
    let endpoint = endpoints.find(
      (each) =>
        each.auth === "chatgpt" &&
        (flow.account ? each.id === flow.account : (each.account as Json)?.email === email),
    );
    if (!endpoint) {
      const taken = endpoints.filter((each) => each.auth === "chatgpt").length;
      endpoint = {
        id: freeId("chatgpt", endpoints),
        name: taken ? `ChatGPT ${taken + 1}` : "ChatGPT",
        format: "openai-responses",
        base_url: "https://chatgpt.com/backend-api/codex/",
        header_names: [],
        session_header: null,
        needs_key: false,
        key_set: false,
        key_source: null,
        provider: "openai",
        auth: "chatgpt",
        models: chatgptModels(),
      };
      endpoints.push(endpoint);
    }
    endpoint.account = { email, plan, signed_in: true };
    flow.json.state = "done";
    flow.json.endpoint = endpoint;
  }
}
