import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Spade's connector routes (ADR 0131, spade/docs/connectors.md) for the fake Spade: a catalogue,
 * connected apps and each bot's allow list. A sign-in waits until a test calls `finishSignIn`.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string, extra: Json = {}) =>
  reply({ error, ...extra }, status);

export class FakeSpadeConnectors {
  catalogue: Json[] = [];
  connectors: Json[] = [];
  /** Allow lists by agent id; absent: Spade may use all, a bot none. */
  readonly access = new Map<string, { all: boolean; connectors: string[] }>();
  /** Catalogue ids whose server offers no registration: connecting needs a client ID. */
  readonly needsClient = new Set<string>();

  /** Ends a sign-in as the person approving it in the browser would. */
  finishSignIn(id: string, account?: string): void {
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return;
    Object.assign(connector, { state: "connected", account: account ?? null, tools: 3 });
  }

  /** `/v1/connectors…`. */
  route(
    method: string,
    id: string | undefined,
    sub: string | undefined,
    body: Json,
  ): FakeSpadeAnswer {
    if (!id && method === "GET")
      return reply({ catalogue: this.catalogue, connectors: this.connectors });
    if (!id && method === "POST") return this.connect(body);
    const connector = this.connectors.find((candidate) => candidate.id === id);
    if (!connector) return problem(404, "no such connector");
    if (sub === "connect" && method === "POST") return this.connect({ ...body, id });
    if (!sub && method === "GET") return reply({ connector });
    if (!sub && method === "DELETE") {
      this.connectors = this.connectors.filter((candidate) => candidate !== connector);
      for (const list of this.access.values())
        list.connectors = list.connectors.filter((each) => each !== id);
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  /** `/v1/agents/{id}/connectors`. */
  agentRoute(method: string, agent: string, isMain: boolean, body: Json): FakeSpadeAnswer {
    if (method === "GET") return reply(this.access.get(agent) ?? { all: isMain, connectors: [] });
    if (method === "PUT") {
      const ids = Array.isArray(body.connectors) ? body.connectors.map(String) : [];
      const unknown = ids.find((each) => !this.connectors.some((c) => c.id === each));
      if (unknown) return problem(400, `no connector named ${unknown}`);
      const list = { all: body.all === true, connectors: body.all === true ? [] : ids };
      this.access.set(agent, list);
      return reply(list);
    }
    return problem(405, "Not allowed.");
  }

  private connect(body: Json): FakeSpadeAnswer {
    const entry = this.catalogue.find((candidate) => candidate.id === body.catalogue);
    const existing = this.connectors.find((candidate) => candidate.id === body.id);
    const id = String(body.id ?? entry?.id ?? "server");
    if (!body.token && !body.client_id && this.needsClient.has(id))
      return problem(409, "this app needs a client ID you register with its maker", {
        needs: "client_id",
      });
    const connector: Json = existing ?? {
      id,
      name: entry?.name ?? body.name ?? id,
      url: entry?.url ?? body.url ?? "",
      catalogue: entry?.id ?? null,
      local: !entry && body.local === true,
      account: null,
      problem: null,
    };
    if (!existing) this.connectors.push(connector);
    if (typeof body.token === "string") {
      Object.assign(connector, { sign_in: "token", state: "connected", tools: 3 });
      return reply({ connector });
    }
    Object.assign(connector, {
      sign_in: "oauth",
      state: "signing_in",
      tools: connector.tools ?? 0,
    });
    return reply({ id, sign_in_url: `https://auth.example/authorize?client=${id}` }, 202);
  }
}
