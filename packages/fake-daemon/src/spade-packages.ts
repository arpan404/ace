import type { FakeSpadeAgent } from "./spade-agent.ts";
import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A linked bot's package routes (ADR 0200 §3.4, spade/docs/packages.md) as the profile uses them:
 * `GET /v1/agents/{id}/package`, and `PUT …/package/effects {key, on}`, which turns one declared
 * effect on or off and refuses a key the package didn't declare, as Spade does.
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
  if (method !== "PUT" || rest[0] !== "effects") return problem(404, "not found");
  const key = isJson(body) ? body["key"] : undefined;
  const on = isJson(body) ? body["on"] : undefined;
  const effects = Array.isArray(link["effects"]) ? link["effects"].filter(isJson) : [];
  if (typeof key !== "string" || typeof on !== "boolean" || !effects.some((e) => e["key"] === key))
    return problem(400, "only an effect its package declares can be turned on");
  agent.package = {
    ...link,
    effects: effects.map((effect) => (effect["key"] === key ? { ...effect, on } : effect)),
  };
  return reply({ package: agent.package });
}
