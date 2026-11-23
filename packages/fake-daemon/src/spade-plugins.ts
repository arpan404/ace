import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A bot's plugins as Spade answers them (ADR 0151, spade/docs/plugins.md): the person's plugins
 * accepted in ace at `GET /v1/agents/{id}/plugins`, each with whether this bot may use it, and
 * `PUT` with `{plugins: [name]}` to set exactly which. A plugin not accepted in ace is refused.
 * Tests stage what ace has accepted with `plugins`.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});

export class FakeSpadePlugins {
  /** The plugins accepted in ace, as Spade lists them (without `allowed`). */
  plugins: Json[] = [];
  /** Each bot's allowed plugins by name; none until turned on. */
  readonly allowed = new Map<string, string[]>();

  route(method: string, agent: string, body: Json): FakeSpadeAnswer {
    if (method === "PUT") {
      const names = Array.isArray(body.plugins) ? body.plugins.map(String) : [];
      const unknown = names.find((name) => !this.plugins.some((each) => each.name === name));
      if (unknown !== undefined) return reply({ error: `${unknown} isn't accepted in ace` }, 400);
      this.allowed.set(agent, [...new Set(names)]);
    } else if (method !== "GET") return reply({ error: "Not allowed." }, 405);
    const allowed = this.allowed.get(agent) ?? [];
    return reply({
      plugins: this.plugins.map((each) => ({
        ...each,
        allowed: allowed.includes(String(each.name)),
      })),
      cli: false,
      problem: null,
    });
  }
}
