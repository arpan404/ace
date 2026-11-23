import type { FakeSpadeAnswer } from "./spade.ts";
import type { FakeSpadeAgent } from "./spade-agent.ts";

/*
 * A bot's move to another machine (ADR 0187) as Spade answers it on the machine it leaves:
 * `GET|POST|DELETE /v1/agents/{id}/move`, `POST …/move/check` and `DELETE …/arrival`. A started
 * move is sending at once; tests set `agent.move` to stage the other states.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

/** What a move reads from the fake Spade it runs on. */
export interface FakeMoveHost {
  readonly agents: readonly FakeSpadeAgent[];
  readonly here: string | undefined;
  readonly machineNames: ReadonlyMap<string, string>;
}

export function fakeMoveRoute(
  host: FakeMoveHost,
  method: string,
  id: string,
  sub: "move" | "arrival",
  subId: string | undefined,
  body: Json,
): FakeSpadeAnswer {
  const agent = host.agents.find((candidate) => candidate.id === id);
  if (!agent) return problem(404, "No such agent.");
  if (sub === "arrival") {
    agent.arrived = null;
    return { status: 204 };
  }
  if (method === "DELETE") {
    agent.move = null;
    return reply({ move: null });
  }
  if (method === "GET") return reply({ move: agent.move ?? null });
  if (subId === "check") return reply({ checking: true });
  if (agent.state !== "idle")
    return problem(
      409,
      `${agent.name} is working; it can move once that ends, or once you stop it.`,
    );
  if (typeof body.move !== "string") return problem(400, "Name the move.");
  const to = String(body.to);
  agent.move = {
    id: body.move,
    to: { host: to, name: host.machineNames.get(to) ?? to },
    state: "sending",
    from: host.here ?? "this-mac",
    via: `dev-${host.here ?? "this-mac"}`,
    digest: "a".repeat(64),
    replaces: agent.kind === "main" ? "main" : "bot",
    sent: 3,
    total: 12,
    waiting: false,
    problem: null,
    can_cancel: true,
  };
  return reply({ move: agent.move }, 202);
}
