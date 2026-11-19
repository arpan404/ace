import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A bot's services (ADR 0160) for the fake API, in Spade's JSON: the list, each one's output
 * read after a line number, and Stop (409 when it isn't running).
 */

export interface FakeService {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  keep: boolean;
  state: "running" | "exited" | "stopped" | "lost" | "failed";
  exit_code: number | null;
  restarts: number;
  /** Everything it printed, line 1 first. */
  output: string[];
}

const answer = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => answer({ error }, status);

export class FakeSpadeServices {
  /** Each bot's services, oldest started first. */
  readonly byAgent = new Map<string, FakeService[]>();
  private sequence = 0;

  start(agent: string, fields: Partial<FakeService> & { name: string; command: string }) {
    const service: FakeService = {
      id: `svc_${++this.sequence}`,
      cwd: null,
      keep: false,
      state: "running",
      exit_code: null,
      restarts: 0,
      output: [],
      ...fields,
    };
    this.byAgent.set(agent, [...(this.byAgent.get(agent) ?? []), service]);
    return service;
  }

  route(method: string, agent: string, rest: string[], query: URLSearchParams) {
    const [name, sub] = rest;
    const all = this.byAgent.get(agent) ?? [];
    if (name === undefined) {
      if (method !== "GET") return problem(405, "Not allowed.");
      return answer({
        services: all.map(({ output: _output, ...service }) => service),
      });
    }
    const service = all.findLast((each) => each.name === name || each.id === name);
    if (sub === "logs" && method === "GET") {
      if (!service) return problem(404, "no such service, or no output kept");
      const after = Number(query.get("after") ?? 0) || 0;
      const most = Math.min(2000, Math.max(1, Number(query.get("lines") ?? 200) || 200));
      const lines = service.output
        .map((text, at) => ({ n: at + 1, text }))
        .filter((line) => line.n > after)
        .slice(-most);
      return answer({ lines, next: service.output.length + 1 });
    }
    if (sub === undefined && method === "DELETE") {
      if (!service || service.state !== "running")
        return problem(409, "that service is not running");
      service.state = "stopped";
      return { status: 204, body: "" };
    }
    return problem(404, "Not found.");
  }
}
