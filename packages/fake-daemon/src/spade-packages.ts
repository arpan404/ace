import type { FakeSpadeAgent } from "./spade-agent.ts";
import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A linked bot's package routes (ADR 0200 §3.4, spade/docs/packages.md) as the profile uses them:
 * `GET /v1/agents/{id}/package`, and `PUT …/package/effects {key, on}`, which turns one declared
 * effect on or off and refuses a key the package didn't declare, as Spade does. A bot made from
 * an ace template has `GET …/package/template`, the newer version offered, and `POST …/package`
 * with that exact package moves it, keeping its switches and starting new ones off.
 * `GET|PUT /v1/agents/{id}/contracts {incoming}` lists its contracts and switches calls to it
 * from the person's other bots (ADR 0200 §7).
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function packageRoute(
  method: string,
  agent: FakeSpadeAgent | undefined,
  rest: readonly string[],
  body: unknown,
): FakeSpadeAnswer {
  if (!agent) return problem(404, "no such bot");
  const link = agent.package;
  if (!isJson(link)) return problem(404, "this bot isn't linked to a package");
  if (method === "GET" && rest.length === 0) return reply({ package: link });
  if (method === "GET" && rest[0] === "template") return templateOffer(agent);
  if (method === "POST" && rest.length === 0) return takeTemplate(agent, link, body);
  if (method !== "PUT" || rest[0] !== "effects") return problem(404, "not found");
  const key = isJson(body) ? body["key"] : undefined;
  const on = isJson(body) ? body["on"] : undefined;
  const effects = Array.isArray(link["effects"]) ? link["effects"].filter(isJson) : [];
  if (typeof key !== "string" || typeof on !== "boolean" || !effects.some((e) => e["key"] === key))
    return problem(400, "only an effect its package declares can be turned on");
  agent.package = {
    ...link,
    // oxlint-disable-next-line oxc/no-map-spread -- A new effect list, as Spade answers; the stored one stays untouched.
    effects: effects.map((effect) => (effect["key"] === key ? { ...effect, on } : effect)),
  };
  return reply({ package: agent.package });
}

function templateOffer(agent: FakeSpadeAgent): FakeSpadeAnswer {
  return agent.templateOffer
    ? reply(agent.templateOffer)
    : problem(404, "this Spade offers no newer version of its template");
}

/** Spade takes only the very template version it offers, by the usual update path. */
function takeTemplate(agent: FakeSpadeAgent, link: Json, body: unknown): FakeSpadeAnswer {
  const offer = agent.templateOffer;
  const offered = offer && isJson(offer["package"]) ? offer["package"] : undefined;
  const claimed = isJson(body) && isJson(body["package"]) ? body["package"] : undefined;
  if (!offered || !claimed || JSON.stringify(claimed) !== JSON.stringify(offered))
    return problem(400, "that isn't the template version this Spade offers");
  const effects = offer && Array.isArray(offer["effects"]) ? offer["effects"] : [];
  const { template_update: _offered, ...rest } = link;
  agent.package = {
    ...rest,
    version: offered["version"],
    hash: offered["hash"],
    previous: { version: link["version"], hash: link["hash"] },
    effects,
  };
  agent.templateOffer = undefined;
  return reply({ package: agent.package });
}

/** A bot's contracts and whether the person's other bots may call it (ADR 0200 §7). */
export function contractsRoute(
  method: string,
  agent: FakeSpadeAgent | undefined,
  body: unknown,
): FakeSpadeAnswer {
  if (!agent) return problem(404, "no such bot");
  const link = isJson(agent.package) ? agent.package : {};
  const contracts = Array.isArray(link["contracts"]) ? link["contracts"] : [];
  if (method === "PUT") {
    const incoming = isJson(body) ? body["incoming"] : undefined;
    if (typeof incoming !== "boolean") return problem(400, "incoming is true or false");
    agent.takesCalls = incoming;
  } else if (method !== "GET") return problem(404, "not found");
  return reply({ contracts, incoming: agent.takesCalls ?? true });
}
